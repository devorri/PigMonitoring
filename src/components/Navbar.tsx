import React from 'react';
import pigLogo from '../assets/pig-logo.png';
import {
  LayoutDashboard,
  ToggleRight,
  Camera,
  AudioWaveform,
  Database,
  PhoneCall,
  Settings,
  DatabaseZap,
} from 'lucide-react';

export type AppTab = 'overview' | 'controls' | 'camera' | 'sound' | 'logs' | 'contacts' | 'settings';

interface NavbarProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  isMock: boolean;
  onOpenConfig: () => void;
  activeContactsCount: number;
  piOnline: boolean;
}

const NAV: { id: AppTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'controls', label: 'Controls', icon: ToggleRight },
  { id: 'camera', label: 'Camera', icon: Camera },
  { id: 'sound', label: 'Sound', icon: AudioWaveform },
  { id: 'logs', label: 'Sensor logs', icon: Database },
  { id: 'contacts', label: 'Contacts & SMS', icon: PhoneCall },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  isMock,
  onOpenConfig,
  activeContactsCount,
  piOnline,
}) => {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src={pigLogo} alt="" className="sidebar-logo" />
        <div>
          <div className="sidebar-name">Pig Monitor</div>
          <div className="sidebar-sub">Pen 1 · Raspberry Pi</div>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`sidebar-link ${activeTab === id ? 'active' : ''}`}
            aria-current={activeTab === id ? 'page' : undefined}
            onClick={() => setActiveTab(id)}
          >
            <Icon className="sidebar-icon" />
            <span>{label}</span>
            {id === 'contacts' && activeContactsCount > 0 && <span className="sidebar-count">{activeContactsCount}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className={`sidebar-status ${piOnline ? 'ok' : 'off'}`}>
          <span className="sidebar-dot" />
          {piOnline ? 'Pi online' : 'Pi offline'}
        </div>
        <button type="button" className="sidebar-db" onClick={onOpenConfig} title="Database connection">
          <DatabaseZap className="sidebar-icon" />
          {isMock ? 'Demo data' : 'Database connected'}
        </button>
      </div>
    </aside>
  );
};
