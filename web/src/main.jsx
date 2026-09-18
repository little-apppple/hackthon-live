import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './dashboard/Dashboard.jsx';
import Admin from './admin/Admin.jsx';
import HomePage from './zsjk/HomePage.jsx';
import MapPage from './zsjk/MapPage.jsx';
import IslandPage from './zsjk/IslandPage.jsx';
import PeoplePage from './zsjk/PeoplePage.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/zsjk" element={<HomePage />} />
      <Route path="/zsjk/map" element={<MapPage />} />
      <Route path="/zsjk/island" element={<IslandPage />} />
      <Route path="/zsjk/people" element={<PeoplePage />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
  </BrowserRouter>
);
