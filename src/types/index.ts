export interface SensorLog {
  id: number;
  created_at: string;
  ambient_temp: number;
  floor_temp: number;
  motion_detected: boolean;
  audio_level: number;
  image_url: string | null;
  audio_url: string | null;
}

export interface SystemSetting {
  id: number;
  setting_key: string;
  setting_value: string;
  updated_at: string;
}

export interface Contact {
  id: number;
  created_at: string;
  name: string;
  phone_number: string;
  is_active: boolean;
}

export interface NewContact {
  name: string;
  phone_number: string;
  is_active?: boolean;
}

export interface NewSensorLog {
  ambient_temp: number;
  floor_temp: number;
  motion_detected: boolean;
  audio_level: number;
  image_url?: string | null;
  audio_url?: string | null;
}
