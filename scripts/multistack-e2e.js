'use strict';
// 多技术栈部署 E2E（生产服务器）：Java 17 / Python 3.6 / SPA 深链接
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'http://47.108.217.153:50000';
const CLI = path.join(__dirname, '..', 'skill', 'hackathon-reporter', 'scripts', 'report.js');
const WORK = path.join(__dirname, '..', 'tmp-multistack');
  const ADMIN_PW = 'pAT-x1Ndnk-h';

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runCli = (args, cwd) =>
  new Promise((resolve) => {
    const c = require('child_process').spawn(process.execPath, [CLI, ...args], { cwd, stdio: 'pipe' });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code, out }));
  });
const curl = (url) => {
  try {
    return execSync(`curl -s -m 12 ${JSON.stringify(url)}`, { encoding: 'utf-8', shell: 'bash' });
  } catch {
    return null;
  }
};

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // ---- 登录 + 三个项目 ----
  const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PW }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const h = { Cookie: cookie, 'Content-Type': 'application/json' };
  const groups = await (await fetch(BASE + '/api/admin/groups', { headers: h })).json();

  // 清理上一轮残留（先归档再彻底删除）
  const old = await (await fetch(BASE + '/api/admin/projects', { headers: h })).json();
  for (const pr of old.projects.filter((x) => x.name.startsWith('多栈演示'))) {
    await fetch(BASE + `/api/admin/projects/${pr.id}/archive`, { method: 'POST', headers: h });
    await fetch(BASE + `/api/admin/projects/${pr.id}`, { method: 'DELETE', headers: h });
  }

  const mk = async (teamName, name) => {
    const g = groups.groups.find((x) => x.name === teamName);
    return (
      await (
        await fetch(BASE + '/api/admin/projects', { method: 'POST', headers: h, body: JSON.stringify({ groupId: g.id, name }) })
      ).json()
    );
  };
  const java = await mk('增长黑客团', '多栈演示 · Java 17');
  const py = await mk('创想工坊', '多栈演示 · Python 3');
  const spa = await mk('数据飞轮', '多栈演示 · SPA 深链接');
  check('三个项目创建', java.ok && py.ok && spa.ok, JSON.stringify({ java, py, spa }));
  const ports = [java.port, py.port, spa.port];
  check('端口依次分配 4103-4105', JSON.stringify(ports) === JSON.stringify([4103, 4104, 4105]), JSON.stringify(ports));

  // ---- 脚手架 ----
  // Java：源码随包上传，启动命令里现场编译（验证自定义启动命令路径）
  const javaDir = path.join(WORK, 'java-app');
  fs.mkdirSync(javaDir, { recursive: true });
  fs.writeFileSync(
    path.join(javaDir, 'Main.java'),
    `import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public class Main {
  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
    server.createContext("/", exchange -> {
      byte[] body = "<h1>JAVA17-OK</h1>".getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
      exchange.sendResponseHeaders(200, body.length);
      try (OutputStream os = exchange.getResponseBody()) { os.write(body); }
    });
    server.start();
    System.out.println("java demo on " + port);
  }
}
`
  );
  // Python：标准库 http.server，验证启动命令里展开 $PORT
  const pyDir = path.join(WORK, 'py-app');
  fs.mkdirSync(pyDir, { recursive: true });
  fs.writeFileSync(path.join(pyDir, 'demo.txt'), 'PYTHON-OK\n');
  // SPA：深链接回退
  const spaDir = path.join(WORK, 'spa');
  fs.mkdirSync(spaDir, { recursive: true });
  fs.writeFileSync(path.join(spaDir, 'index.html'), '<h1>SPA-DEEP-LINK-OK</h1><script src="app.js"></script>');
  fs.writeFileSync(path.join(spaDir, 'app.js'), 'console.log("spa");');

  // configs（用真实 CLI --init 生成骨架后补 deploy.start）
  const cfgOf = {};
  const teams = [
    { p: java, dir: 'java-app', type: 'node' },
    { p: py, dir: 'py-app', type: 'node' },
    { p: spa, dir: 'spa', type: 'static' },
  ];
  for (const t of teams) {
    const dir = path.join(WORK, 'cfg-' + t.p.port);
    fs.mkdirSync(dir, { recursive: true });
    const r = await runCli([
      '--init', '--server-url', BASE, '--access-key', t.p.accessKey, '--deploy-url', t.p.deployUrl,
    ], dir);
    check(`--init 接入（${t.p.name}）`, r.code === 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'hackathon.config.json'), 'utf-8'));
    cfg.deploy = {
      type: t.type,
      install: false,
      dir: path.relative(dir, path.join(WORK, t.dir)).split(path.sep).join('/'),
      ...(t.type === 'node' ? { start: '' } : {}),
    };
    if (t.p === java) cfg.deploy.start = 'javac Main.java && java Main';
    if (t.p === py) cfg.deploy.start = 'python3 -m http.server $PORT';
    if (t.type === 'static') delete cfg.deploy.start;
    cfg.verify = { api: 'node check.js', e2e: 'node check.js' };
    fs.writeFileSync(path.join(dir, 'hackathon.config.json'), JSON.stringify(cfg, null, 2));
    fs.writeFileSync(path.join(dir, 'check.js'), `fetch(process.env.DEPLOY_URL).then((r) => r.text()).then((t) => { process.exit(t.includes(process.env.MARKER) ? 0 : 1); }).catch(() => process.exit(1));`);
    const marker = t.p === java ? 'JAVA17-OK' : t.p === py ? 'PYTHON-OK' : 'SPA-DEEP-LINK-OK';
    const checkPath = t.p === py ? '/demo.txt' : '/';
    fs.writeFileSync(
      path.join(dir, 'check.js'),
      `fetch(process.env.DEPLOY_URL + ${JSON.stringify(checkPath)}).then((r) => r.text()).then((t) => { process.exit(t.includes(${JSON.stringify(marker)}) ? 0 : 1); }).catch(() => process.exit(1));`
    );
    cfgOf[t.p.port] = { dir, marker, proj: t.p };
  }

  // ---- 交错上报节点 1-5（限频按项目隔离，无需等待） ----
  const stages = ['requirements', 'design', 'prototype', 'coding', 'testing'];
  for (const st of stages) {
    for (const port of ports) {
      const c = cfgOf[port];
      const r = await runCli(['--stage', st, '--message', 'multistack'], c.dir);
      check(`上报 ${st}（端口 ${port}）`, r.code === 0, r.out.slice(-120));
    }
  }

  // ---- 部署三个 ----
  const deploy = async (port, extra = []) => {
    const c = cfgOf[port];
    const r = await runCli(['--deploy', ...extra], c.dir);
    check(`--deploy（端口 ${port}）`, r.code === 0, r.out.slice(-200));
    return r;
  };
  await deploy(ports[0]); // java：启动命令内现场 javac
  await deploy(ports[1]); // python：http.server
  await deploy(ports[2]); // spa：静态托管

  // ---- 部署结果验证（公网） ----
  const body0 = curl(`http://47.108.217.153:${ports[0]}/`);
  check('Java 17 页面内容', body0 && body0.includes('JAVA17-OK'), String(body0).slice(0, 80));
  const body1 = curl(`http://47.108.217.153:${ports[1]}/demo.txt`);
  check('Python $PORT 展开且文件可访问', body1 && body1.includes('PYTHON-OK'), String(body1).slice(0, 80));
  const deep = curl(`http://47.108.217.153:${ports[2]}/detail/abc`);
  check('SPA 深链接 /detail/abc 回退到 index', deep && deep.includes('SPA-DEEP-LINK-OK'), String(deep).slice(0, 80));

  // ---- --verify 三个（check.js 用 MARKER 环境变量区分标记） ----
  for (const port of ports) {
    const c = cfgOf[port];
    const r = await runCli(['--verify'], c.dir);
    // check.js 校验 DEPLOY_URL 内容含 marker；MARKER 未注入时 check.js 会失败——
    // 因此这里把 marker 写进每个 cfg 目录的 check.js 已在上方完成（marker 不同），
    // 用环境变量方式改为直接内嵌 marker 常量，见下方修正。
    check(`--verify 自动验收（端口 ${port}）`, r.code === 0, r.out.slice(-160));
  }

  // ---- 大屏 KPI ----
  const snap = await (await fetch(BASE + '/api/snapshot')).json();
  check('KPI deployed=6', snap.snapshot.kpi.deployed === 6, JSON.stringify(snap.snapshot.kpi));
  check('KPI done=6', snap.snapshot.kpi.done === 6);

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 异常:', e);
  process.exit(1);
});
