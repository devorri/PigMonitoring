export interface SensorLog {
  id: number;
  created_at: string;
  ambient_temp: number | null;
  floor_temp: number | null;
  motion_detected: boolean | null;
  audio_level: number | null;
  image_url: string | null;
  audio_url: string | null;
}

/** One row the Pi writes every audio_interval_seconds (audio AI summary). */
export interface AudioDetection {
  id: number;
  created_at: string;
  sensor_log_id: number | null;
  audio_url: string | null;
  top_class: string | null;
  cough_prob: number | null;
  stress_prob: number | null;
  cough_events: number;
  stress_events: number;
  status: 'HEALTHY' | 'ATTENTION NEEDED' | string | null;
}

/** One SMS the Pi sent (or failed to send) through Semaphore. */
export interface SmsLog {
  id: number;
  created_at: string;
  alert_type: string | null;
  message: string | null;
  numbers: string | null;
  status: 'sent' | 'failed' | string | null;
  error: string | null;
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
