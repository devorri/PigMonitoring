import React from 'react';
import pigLogo from '../assets/pig-logo.png';
import { LayoutDashboard, Database, PhoneCall, Settings, DatabaseZap } from 'lucide-react';

interface NavbarProps {
  activeTab: 'overview' | 'logs' | 'contacts' | 'settings';
  setActiveTab: (tab: 'overview' | 'logs' | 'contacts' | 'settings') => void;
  isMock: boolean;
  onOpenConfig: () => void;
  activeContactsCount: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  isMock,
  onOpenConfig,
  activeContactsCount,
}) => {
  return (
    <header className="navbar-container">
      <div className="navbar-content">
        {/* Brand & Logo */}
        <div className="brand-section">
          <div className="logo-wrapper">
            <div className="logo-shield">
              <img src={pigLogo} alt="Pig Monitoring System Logo" className="brand-logo" />
            </div>
            <div className="logo-glow"></div>
          </div>
          <div className="brand-titles">
            <div className="brand-badge">
              <span className="live-pulse"></span>
              PIG MONITORING SYSTEM
            </div>
            <h1 className="brand-name">
              Pig Monitoring <span className="gradient-text">System</span>
            </h1>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="nav-tabs">
          <button
            className={`nav-tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <LayoutDashboard className="tab-icon" />
            <span>Dashboard</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            <Database className="tab-icon" />
            <span>Sensor Logs</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'contacts' ? 'active' : ''}`}
            onClick={() => setActiveTab('contacts')}
          >
            <PhoneCall className="tab-icon" />
            <span>Contacts</span>
            <span className="tab-badge">{activeContactsCount}</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings className="tab-icon" />
            <span>Settings</span>
          </button>
        </nav>

        {/* Right Utility Actions */}
        <div className="nav-actions">
          <button
            className={`db-status-btn ${isMock ? 'mock-mode' : 'connected-mode'}`}
            onClick={onOpenConfig}
            title="Manage Supabase connection credentials"
          >
            <DatabaseZap className="status-icon" />
            <span className="status-label">{isMock ? 'Demo Mode' : 'Supabase Live'}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
