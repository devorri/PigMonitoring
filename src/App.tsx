import { useState, useEffect } from 'react';
import { Navbar, type AppTab } from './components/Navbar';
import { SoundView } from './components/SoundView';
import { DashboardOverview } from './components/DashboardOverview';
import { SensorLogsView } from './components/SensorLogsView';
import { ContactsView } from './components/ContactsView';
import { SmsAlertsPanel } from './components/SmsAlertsPanel';
import { SystemSettingsView } from './components/SystemSettingsView';
import { PI_OFFLINE_AFTER_S, PI_WRITTEN_KEYS, parseRelayState } from './lib/settingsSpec';
import { SupabaseConfigModal } from './components/SupabaseConfigModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { 
  AudioDetection,
  Contact, 
  SmsLog,
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
  fetchAudioDetections,
  normalizeAudioDetection,
  fetchSmsLogs,
  normalizeSmsLog,
  subscribeToRealtimeChanges,
  normalizeSensorLog
} from './lib/supabase';
import { CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';

export function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('overview');
  
  // Data States
  const [logs, setLogs] = useState<SensorLog[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [audioDetections, setAudioDetections] = useState<AudioDetection[]>([]);
  const [smsLogs, setSmsLogs] = useState<SmsLog[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);
  
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
      const dataRequest = Promise.all([
        fetchSensorLogs(),
        fetchContacts(),
        fetchSystemSettings(),
        fetchAudioDetections(),
        fetchSmsLogs(),
      ]);
      const timeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('Telemetry request timed out')), 5000);
      });
      const [logsRes, contactsRes, settingsRes, audioRes, smsRes] = await Promise.race([dataRequest, timeout]);

      setLogs(logsRes.data);
      setContacts(contactsRes.data);
      setSettings(settingsRes.data);
      setAudioDetections(audioRes);
      setSmsLogs(smsRes);

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
          const newLog = normalizeSensorLog(payload.new);
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
          // relay_state / pi_status / cam_status change every few seconds -> no toast
          if (!PI_WRITTEN_KEYS.has(updatedSetting.setting_key)) {
            showToast(`Realtime Setting updated: ${updatedSetting.setting_key}`);
          }
        }
      },
      // On new audio AI result from the Pi
      (payload) => {
        if (payload.new) {
          const det = normalizeAudioDetection(payload.new);
          setAudioDetections((prev) => (prev.some((d) => d.id === det.id) ? prev : [det, ...prev]));
          if (det.status === 'ATTENTION NEEDED') {
            showToast(`Audio AI: ${det.top_class} (${det.cough_events} cough / ${det.stress_events} stress)`, 'warning');
          }
        }
      },
      // On SMS sent by the Pi
      (payload) => {
        if (payload.new) {
          const sms = normalizeSmsLog(payload.new);
          setSmsLogs((prev) => (prev.some((l) => l.id === sms.id) ? prev : [sms, ...prev]));
          showToast(sms.status === 'sent' ? `SMS sent: ${sms.alert_type}` : `SMS failed: ${sms.error}`, sms.status === 'sent' ? 'info' : 'warning');
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

  const relay = parseRelayState(settings);
  const piOnline = !!relay && clock / 1000 - relay.t < PI_OFFLINE_AFTER_S;

  const PAGE_HEAD: Partial<Record<AppTab, { title: string; sub: string }>> = {
    overview: { title: 'Overview', sub: 'How the pen is doing right now.' },
    controls: { title: 'Controls', sub: 'Heating bulb and water sprinkler. Heat protection always has the last word.' },
    camera: { title: 'Camera', sub: 'Live view from the pen with pig detection.' },
    sound: { title: 'Sound', sub: 'Coughs and stress sounds picked up by the barn microphone.' },
  };
  const head = PAGE_HEAD[activeTab];

  return (
    <div className="app-shell">
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isMock={isMock}
        onOpenConfig={() => setIsConfigModalOpen(true)}
        activeContactsCount={activeContactsCount}
        piOnline={piOnline}
      />

      {toastMessage && (
        <div className={`toast toast-${toastMessage.type}`} role="status">
          {toastMessage.type === 'warning' ? <AlertTriangle className="btn-icon" /> : <CheckCircle2 className="btn-icon" />}
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Main Page Area */}
      <main className="main-content">
        {head && !isLoading && (
          <header className="view-header">
            <div>
              <h1 className="view-title">{head.title}</h1>
              <p className="view-subtitle">{head.sub}</p>
            </div>
          </header>
        )}
        {isLoading ? (
          <div className="loading-state">
            <RefreshCw className="loading-icon animate-spin" />
            <p>Loading the latest readings…</p>
          </div>
        ) : (
          <ErrorBoundary>
            {(activeTab === 'overview' || activeTab === 'controls' || activeTab === 'camera') && (
              <DashboardOverview
                key={activeTab}
                section={activeTab}
                logs={logs}
                settings={settings}
                audioDetections={audioDetections}
                smsLogs={smsLogs}
                onNavigateLogs={() => setActiveTab('logs')}
                onNavigateSettings={() => setActiveTab('settings')}
                onUpdateSetting={handleUpdateSetting}
              />
            )}

            {activeTab === 'logs' && (
              <SensorLogsView
                logs={logs}
                settings={settings}
                audioDetections={audioDetections}
                onAddLog={handleAddSensorLog}
              />
            )}

            {activeTab === 'contacts' && (
              <ContactsView
                topSlot={
                  <SmsAlertsPanel
                    settings={settings}
                    contacts={contacts}
                    smsLogs={smsLogs}
                    onUpdateSetting={handleUpdateSetting}
                    onOpenSettings={() => setActiveTab('settings')}
                  />
                }
                contacts={contacts}
                onAddContact={handleAddContact}
                onUpdateContact={handleUpdateContact}
                onDeleteContact={handleDeleteContact}
              />
            )}

            {activeTab === 'sound' && <SoundView audioDetections={audioDetections} settings={settings} />}

            {activeTab === 'settings' && (
              <SystemSettingsView
                settings={settings}
                onUpdateSetting={handleUpdateSetting}
                onResetDefaults={handleResetDefaults}
              />
            )}
          </ErrorBoundary>
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
