import { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { DashboardOverview } from './components/DashboardOverview';
import { SensorLogsView } from './components/SensorLogsView';
import { ContactsView } from './components/ContactsView';
import { SystemSettingsView } from './components/SystemSettingsView';
import { SupabaseConfigModal } from './components/SupabaseConfigModal';
import type { 
  Contact, 
  NewContact, 
  NewSensorLog, 
  SensorLog, 
  SystemSetting 
} from './types';
import { 
  fetchContacts, 
  addContact, 
  updateContact, 
  deleteContact, 
  fetchSensorLogs, 
  addSensorLog, 
  fetchSystemSettings, 
  updateSystemSetting,
  resetLocalDatabase,
  subscribeToRealtimeChanges
} from './lib/supabase';
import { CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';

export function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'logs' | 'contacts' | 'settings'>('overview');
  
  // Data States
  const [logs, setLogs] = useState<SensorLog[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  
  // Status Flags
  const [isLoading, setIsLoading] = useState(true);
  const [isMock, setIsMock] = useState(true);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [autoSyncEnabled] = useState(true);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'info' | 'warning' } | null>(null);

  const showToast = (text: string, type: 'success' | 'info' | 'warning' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Initial Data Loader
  const loadAllData = async () => {
    try {
      const [logsRes, contactsRes, settingsRes] = await Promise.all([
        fetchSensorLogs(),
        fetchContacts(),
        fetchSystemSettings(),
      ]);

      setLogs(logsRes.data);
      setContacts(contactsRes.data);
      setSettings(settingsRes.data);

      setIsMock(logsRes.isMock && contactsRes.isMock && settingsRes.isMock);
    } catch (e) {
      console.error('Error fetching dashboard telemetry:', e);
      showToast('Error connecting to database. Using offline state.', 'warning');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAllData();
  }, []);

  // 1. Supabase Real-Time Postgres Change Listeners
  useEffect(() => {
    const channel = subscribeToRealtimeChanges(
      // On Sensor Log Change
      (payload) => {
        if (payload.eventType === 'INSERT' && payload.new) {
          const newLog = payload.new as SensorLog;
          setLogs((prev) => {
            if (prev.some((l) => l.id === newLog.id)) return prev;
            return [newLog, ...prev];
          });
          showToast(`Realtime Log #${newLog.id} received!`);
        } else if (payload.eventType === 'DELETE' && payload.old) {
          setLogs((prev) => prev.filter((l) => l.id !== payload.old.id));
        }
      },
      // On Contact Change
      (payload) => {
        if (payload.eventType === 'INSERT' && payload.new) {
          const newContact = payload.new as Contact;
          setContacts((prev) => [newContact, ...prev.filter((c) => c.id !== newContact.id)]);
          showToast(`Realtime Contact added: ${newContact.name}`);
        } else if (payload.eventType === 'UPDATE' && payload.new) {
          const updated = payload.new as Contact;
          setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
          showToast(`Realtime Contact updated: ${updated.name}`);
        } else if (payload.eventType === 'DELETE' && payload.old) {
          setContacts((prev) => prev.filter((c) => c.id !== payload.old.id));
        }
      },
      // On Setting Change
      (payload) => {
        if ((payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') && payload.new) {
          const updatedSetting = payload.new as SystemSetting;
          setSettings((prev) => {
            const idx = prev.findIndex((s) => s.setting_key === updatedSetting.setting_key);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = updatedSetting;
              return next;
            }
            return [...prev, updatedSetting];
          });
          showToast(`Realtime Setting updated: ${updatedSetting.setting_key}`);
        }
      }
    );

    return () => {
      if (channel) {
        channel.unsubscribe();
      }
    };
  }, []);

  // 2. Real-Time Telemetry Auto-Poll Loop (3-second cadence for real-time live feel)
  useEffect(() => {
    if (!autoSyncEnabled) return;
    const timer = setInterval(() => {
      loadAllData();
    }, 3000);
    return () => clearInterval(timer);
  }, [autoSyncEnabled]);

  // Handlers for Contacts CRUD
  const handleAddContact = async (contact: NewContact) => {
    try {
      const created = await addContact(contact);
      setContacts((prev) => [created, ...prev]);
      showToast(`Contact "${created.name}" added!`);
    } catch (e) {
      showToast('Failed to add contact.', 'warning');
    }
  };

  const handleUpdateContact = async (id: number, updates: Partial<Contact>) => {
    try {
      const updated = await updateContact(id, updates);
      setContacts((prev) => prev.map((c) => (c.id === id ? updated : c)));
      showToast(`Updated contact "${updated.name}"`);
    } catch (e) {
      showToast('Failed to update contact.', 'warning');
    }
  };

  const handleDeleteContact = async (id: number) => {
    try {
      await deleteContact(id);
      setContacts((prev) => prev.filter((c) => c.id !== id));
      showToast('Contact deleted from database', 'info');
    } catch (e) {
      showToast('Failed to delete contact.', 'warning');
    }
  };

  // Handlers for Sensor Logs Addition
  const handleAddSensorLog = async (log: NewSensorLog) => {
    try {
      const created = await addSensorLog(log);
      setLogs((prev) => [created, ...prev]);
      showToast(`Sensor reading #${created.id} submitted!`);
    } catch (e) {
      showToast('Failed to submit sensor reading', 'warning');
    }
  };

  // Handlers for System Settings Update
  const handleUpdateSetting = async (key: string, value: string) => {
    try {
      const updated = await updateSystemSetting(key, value);
      setSettings((prev) => {
        const idx = prev.findIndex((s) => s.setting_key === key);
        if (idx !== -1) {
          const next = [...prev];
          next[idx] = updated;
          return next;
        }
        return [...prev, updated];
      });
      showToast(`Setting "${key}" updated to "${value}"`);
    } catch (e) {
      showToast('Failed to update setting.', 'warning');
    }
  };

  const handleResetDefaults = () => {
    resetLocalDatabase();
    loadAllData();
    showToast('Reset database state to initial defaults', 'info');
  };

  const activeContactsCount = contacts.filter((c) => c.is_active).length;

  return (
    <div className="app-container">
      {/* Top Navbar Header */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isMock={isMock}
        onOpenConfig={() => setIsConfigModalOpen(true)}
        activeContactsCount={activeContactsCount}
      />

      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center space-x-3 px-4 py-3 rounded-xl border shadow-xl transition-all duration-300 bg-white ${
          toastMessage.type === 'warning'
            ? 'border-amber-300 text-amber-900 shadow-amber-500/10'
            : toastMessage.type === 'info'
            ? 'border-indigo-200 text-indigo-900 shadow-indigo-500/10'
            : 'border-pink-200 text-slate-800 shadow-pink-500/10'
        }`}>
          {toastMessage.type === 'warning' ? (
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-pink-600 flex-shrink-0" />
          )}
          <span className="text-sm font-semibold">{toastMessage.text}</span>
        </div>
      )}

      {/* Main Page Area */}
      <main className="main-content">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-24 space-y-4">
            <RefreshCw className="w-10 h-10 text-rose-500 animate-spin" />
            <p className="text-slate-400 font-semibold text-sm">Synchronizing Real-Time Telemetry...</p>
          </div>
        ) : (
          <>
            {activeTab === 'overview' && (
              <DashboardOverview
                logs={logs}
                settings={settings}
                onNavigateLogs={() => setActiveTab('logs')}
                onNavigateSettings={() => setActiveTab('settings')}
              />
            )}

            {activeTab === 'logs' && (
              <SensorLogsView logs={logs} onAddLog={handleAddSensorLog} />
            )}

            {activeTab === 'contacts' && (
              <ContactsView
                contacts={contacts}
                onAddContact={handleAddContact}
                onUpdateContact={handleUpdateContact}
                onDeleteContact={handleDeleteContact}
              />
            )}

            {activeTab === 'settings' && (
              <SystemSettingsView
                settings={settings}
                onUpdateSetting={handleUpdateSetting}
                onResetDefaults={handleResetDefaults}
              />
            )}
          </>
        )}
      </main>

      {/* Supabase Connection Setup Modal */}
      <SupabaseConfigModal
        isOpen={isConfigModalOpen}
        onClose={() => setIsConfigModalOpen(false)}
        onRefreshData={loadAllData}
      />
    </div>
  );
}

export default App;
