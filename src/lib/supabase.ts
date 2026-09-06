import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import type { Contact, NewContact, NewSensorLog, SensorLog, SystemSetting } from '../types';

// Default Supabase project details from user's environment or provided reference
const DEFAULT_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://rembfnigpvtuxoyjjexf.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 
  import.meta.env.VITE_SUPABASE_ANON_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlbWJmbmlncHZ0dXhveWpqZXhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NDUzMTksImV4cCI6MjEwNDIyMTMxOX0.HIZvxN9LRPQl_9vh-bY1rqaMbh2mHhvGWIqZrR9ZftA';

// LocalStorage Keys for fallback persistence
const LOCAL_STORAGE_KEYS = {
  SUPABASE_URL: 'pig_monitor_supabase_url',
  SUPABASE_KEY: 'pig_monitor_supabase_key',
  CONTACTS: 'pig_monitor_contacts',
  SENSOR_LOGS: 'pig_monitor_sensor_logs',
  SYSTEM_SETTINGS: 'pig_monitor_system_settings',
};

export const getStoredSupabaseConfig = () => {
  return {
    url: localStorage.getItem(LOCAL_STORAGE_KEYS.SUPABASE_URL) || DEFAULT_SUPABASE_URL,
    anonKey: localStorage.getItem(LOCAL_STORAGE_KEYS.SUPABASE_KEY) || DEFAULT_SUPABASE_ANON_KEY,
  };
};

export const saveSupabaseConfig = (url: string, anonKey: string) => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.SUPABASE_URL, url);
  localStorage.setItem(LOCAL_STORAGE_KEYS.SUPABASE_KEY, anonKey);
};

let supabaseInstance: SupabaseClient | null = null;

export const getSupabaseClient = (): SupabaseClient | null => {
  const config = getStoredSupabaseConfig();
  if (!config.url || !config.anonKey) {
    return null;
  }
  if (!supabaseInstance) {
    supabaseInstance = createClient(config.url, config.anonKey);
  }
  return supabaseInstance;
};

export const resetSupabaseClient = () => {
  if (supabaseInstance) {
    supabaseInstance.removeAllChannels();
  }
  supabaseInstance = null;
};

// Real-Time Postgres Changes Subscription
export const subscribeToRealtimeChanges = (
  onSensorLogChange: (payload: any) => void,
  onContactChange: (payload: any) => void,
  onSettingChange: (payload: any) => void
): RealtimeChannel | null => {
  const client = getSupabaseClient();
  if (!client) return null;

  const channel = client
    .channel('pig-monitoring-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'sensor_logs' },
      (payload) => onSensorLogChange(payload)
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'contacts' },
      (payload) => onContactChange(payload)
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'system_settings' },
      (payload) => onSettingChange(payload)
    )
    .subscribe((status) => {
      console.log('Supabase Realtime Connection Status:', status);
    });

  return channel;
};

// Initial Seed Data for fallback interactive demo mode
const INITIAL_CONTACTS: Contact[] = [
  {
    id: 1,
    created_at: new Date(Date.now() - 86400000 * 5).toISOString(),
    name: 'Dr. Sarah Jenkins (Lead Veterinarian)',
    phone_number: '+1 (555) 019-2834',
    is_active: true,
  },
  {
    id: 2,
    created_at: new Date(Date.now() - 86400000 * 3).toISOString(),
    name: 'Mark Miller (Head Barn Supervisor)',
    phone_number: '+1 (555) 014-9921',
    is_active: true,
  },
  {
    id: 3,
    created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
    name: 'Elena Rostova (Night Shift Specialist)',
    phone_number: '+1 (555) 018-3342',
    is_active: false,
  },
  {
    id: 4,
    created_at: new Date(Date.now() - 86400000 * 1).toISOString(),
    name: 'Farm Emergency Hotline',
    phone_number: '+1 (800) 555-PIGS',
    is_active: true,
  },
];

const INITIAL_SETTINGS: SystemSetting[] = [
  {
    id: 1,
    setting_key: 'temp_threshold_high',
    setting_value: '26.5',
    updated_at: new Date().toISOString(),
  },
  {
    id: 2,
    setting_key: 'temp_threshold_low',
    setting_value: '18.0',
    updated_at: new Date().toISOString(),
  },
  {
    id: 3,
    setting_key: 'noise_alert_level',
    setting_value: '75',
    updated_at: new Date().toISOString(),
  },
  {
    id: 4,
    setting_key: 'motion_sensitivity',
    setting_value: 'High',
    updated_at: new Date().toISOString(),
  },
  {
    id: 5,
    setting_key: 'alert_sms_enabled',
    setting_value: 'true',
    updated_at: new Date().toISOString(),
  },
  {
    id: 6,
    setting_key: 'auto_ventilation_mode',
    setting_value: 'Automatic (Smart Thermal)',
    updated_at: new Date().toISOString(),
  },
];

const SAMPLE_PIG_IMAGES = [
  'https://images.unsplash.com/photo-1516467508483-a7212febe31a?auto=format&fit=crop&w=1000&q=80',
  'https://images.unsplash.com/photo-1570042707221-39c4d9fa2435?auto=format&fit=crop&w=1000&q=80',
  'https://images.unsplash.com/photo-1548550023-2bdb3c5beed7?auto=format&fit=crop&w=1000&q=80',
  'https://images.unsplash.com/photo-1596733430284-f7437764b1a9?auto=format&fit=crop&w=1000&q=80',
];

const generateInitialSensorLogs = (): SensorLog[] => {
  const logs: SensorLog[] = [];
  const now = Date.now();
  
  // Create 24 hourly data points for rich initial charts
  for (let i = 24; i >= 0; i--) {
    const time = new Date(now - i * 3600 * 1000).toISOString();
    const ambient = +(21.5 + Math.sin(i / 3) * 2.2 + (Math.random() * 0.8 - 0.4)).toFixed(1);
    const floor = +(ambient - 1.2 + (Math.random() * 0.5 - 0.25)).toFixed(1);
    const motion = Math.random() > 0.45;
    const audio = Math.floor(45 + Math.random() * 32);
    const imgIndex = i % SAMPLE_PIG_IMAGES.length;

    logs.push({
      id: 25 - i,
      created_at: time,
      ambient_temp: ambient,
      floor_temp: floor,
      motion_detected: motion,
      audio_level: audio,
      image_url: SAMPLE_PIG_IMAGES[imgIndex],
      audio_url: 'https://actions.google.com/sounds/v1/animals/pig_grunt.ogg',
    });
  }
  return logs;
};

// Fallback Local Storage Helpers
const getLocalData = <T>(key: string, initialDefault: T): T => {
  const data = localStorage.getItem(key);
  if (!data) {
    localStorage.setItem(key, JSON.stringify(initialDefault));
    return initialDefault;
  }
  try {
    return JSON.parse(data);
  } catch {
    return initialDefault;
  }
};

const setLocalData = <T>(key: string, data: T) => {
  localStorage.setItem(key, JSON.stringify(data));
};

// Data Layer APIs for Contacts
export const fetchContacts = async (): Promise<{ data: Contact[]; isMock: boolean }> => {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from('contacts').select('*').order('id', { ascending: false });
      if (!error && data) {
        return { data, isMock: false };
      }
    } catch (e) {
      console.warn('Supabase fetch contacts failed, using fallback mode', e);
    }
  }
  const contacts = getLocalData<Contact[]>(LOCAL_STORAGE_KEYS.CONTACTS, INITIAL_CONTACTS);
  return { data: contacts, isMock: true };
};

export const addContact = async (contact: NewContact): Promise<Contact> => {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from('contacts').insert([contact]).select().single();
      if (!error && data) {
        return data;
      }
    } catch (e) {
      console.warn('Supabase add contact failed, saving locally', e);
    }
  }
  
  const contacts = getLocalData<Contact[]>(LOCAL_STORAGE_KEYS.CONTACTS, INITIAL_CONTACTS);
  const newId = contacts.length > 0 ? Math.max(...contacts.map(c => c.id)) + 1 : 1;
  const newContactObj: Contact = {
    id: newId,
    created_at: new Date().toISOString(),
    name: contact.name,
    phone_number: contact.phone_number,
    is_active: contact.is_active ?? true,
  };
  const updated = [newContactObj, ...contacts];
  setLocalData(LOCAL_STORAGE_KEYS.CONTACTS, updated);
  return newContactObj;
};

export const updateContact = async (id: number, updates: Partial<Contact>): Promise<Contact> => {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from('contacts').update(updates).eq('id', id).select().single();
      if (!error && data) {
        return data;
      }
    } catch (e) {
      console.warn('Supabase update contact failed, updating locally', e);
    }
  }

  const contacts = getLocalData<Contact[]>(LOCAL_STORAGE_KEYS.CONTACTS, INITIAL_CONTACTS);
  const index = contacts.findIndex(c => c.id === id);
  if (index === -1) throw new Error('Contact not found');

  const updatedContact = { ...contacts[index], ...updates };
  contacts[index] = updatedContact;
  setLocalData(LOCAL_STORAGE_KEYS.CONTACTS, contacts);
  return updatedContact;
};

export const deleteContact = async (id: number): Promise<boolean> => {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { error } = await client.from('contacts').delete().eq('id', id);
      if (!error) return true;
    } catch (e) {
      console.warn('Supabase delete contact failed, deleting locally', e);
    }
  }

  const contacts = getLocalData<Contact[]>(LOCAL_STORAGE_KEYS.CONTACTS, INITIAL_CONTACTS);
  const filtered = contacts.filter(c => c.id !== id);
  setLocalData(LOCAL_STORAGE_KEYS.CONTACTS, filtered);
  return true;
};

// Data Layer APIs for Sensor Logs
export const fetchSensorLogs = async (): Promise<{ data: SensorLog[]; isMock: boolean }> => {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from('sensor_logs').select('*').order('created_at', { ascending: false }).limit(100);
      if (!error && data && data.length > 0) {
        return { data, isMock: false };
      }
    } catch (e) {
      console.warn('Supabase fetch sensor_logs failed, using local mock data', e);
    }
  }

  const logs = getLocalData<SensorLog[]>(LOCAL_STORAGE_KEYS.SENSOR_LOGS, generateInitialSensorLogs());
  return { data: logs, isMock: true };
};

export const addSensorLog = async (log: NewSensorLog): Promise<SensorLog> => {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from('sensor_logs').insert([log]).select().single();
      if (!error && data) {
        return data;
      }
    } catch (e) {
      console.warn('Supabase add sensor_log failed, inserting locally', e);
    }
  }

  const logs = getLocalData<SensorLog[]>(LOCAL_STORAGE_KEYS.SENSOR_LOGS, generateInitialSensorLogs());
  const maxId = logs.length > 0 ? Math.max(...logs.map(l => l.id)) : 0;
  const imgIndex = Math.floor(Math.random() * SAMPLE_PIG_IMAGES.length);
  const newLogObj: SensorLog = {
    id: maxId + 1,
    created_at: new Date().toISOString(),
    ambient_temp: log.ambient_temp,
    floor_temp: log.floor_temp,
    motion_detected: log.motion_detected,
    audio_level: log.audio_level,
    image_url: log.image_url || SAMPLE_PIG_IMAGES[imgIndex],
    audio_url: log.audio_url || 'https://actions.google.com/sounds/v1/animals/pig_grunt.ogg',
  };
  const updated = [newLogObj, ...logs];
  setLocalData(LOCAL_STORAGE_KEYS.SENSOR_LOGS, updated);
  return newLogObj;
};

// Data Layer APIs for System Settings
export const fetchSystemSettings = async (): Promise<{ data: SystemSetting[]; isMock: boolean }> => {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data, error } = await client.from('system_settings').select('*').order('id', { ascending: true });
      if (!error && data && data.length > 0) {
        return { data, isMock: false };
      }
    } catch (e) {
      console.warn('Supabase fetch system_settings failed, using local mock data', e);
    }
  }

  const settings = getLocalData<SystemSetting[]>(LOCAL_STORAGE_KEYS.SYSTEM_SETTINGS, INITIAL_SETTINGS);
  return { data: settings, isMock: true };
};

export const updateSystemSetting = async (key: string, value: string): Promise<SystemSetting> => {
  const client = getSupabaseClient();
  const now = new Date().toISOString();

  if (client) {
    try {
      // Upsert by key
      const { data, error } = await client
        .from('system_settings')
        .upsert({ setting_key: key, setting_value: value, updated_at: now }, { onConflict: 'setting_key' })
        .select()
        .single();
      if (!error && data) {
        return data;
      }
    } catch (e) {
      console.warn('Supabase update system_setting failed, updating locally', e);
    }
  }

  const settings = getLocalData<SystemSetting[]>(LOCAL_STORAGE_KEYS.SYSTEM_SETTINGS, INITIAL_SETTINGS);
  const index = settings.findIndex(s => s.setting_key === key);
  let updatedSetting: SystemSetting;

  if (index !== -1) {
    updatedSetting = { ...settings[index], setting_value: value, updated_at: now };
    settings[index] = updatedSetting;
  } else {
    const maxId = settings.length > 0 ? Math.max(...settings.map(s => s.id)) : 0;
    updatedSetting = { id: maxId + 1, setting_key: key, setting_value: value, updated_at: now };
    settings.push(updatedSetting);
  }

  setLocalData(LOCAL_STORAGE_KEYS.SYSTEM_SETTINGS, settings);
  return updatedSetting;
};

export const resetLocalDatabase = () => {
  localStorage.removeItem(LOCAL_STORAGE_KEYS.CONTACTS);
  localStorage.removeItem(LOCAL_STORAGE_KEYS.SENSOR_LOGS);
  localStorage.removeItem(LOCAL_STORAGE_KEYS.SYSTEM_SETTINGS);
};
