import { need, rid, str, type MockTool } from './util';

const validTime = (t: unknown) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

/** Clock and reminders on the user's phone, simulated. */
export const clock: MockTool = {
  list_alarms: () => ({ providerRef: rid('clock-list-'), result: { alarms: [{ alarmId: 'alarm_weekday', time: '06:45', label: 'Weekdays', enabled: true }] } }),
  set_alarm: p => {
    need(validTime(p.time), 'Alarm time must be HH:MM (24-hour)');
    const id = rid('alarm_');
    return { providerRef: id, result: { alarmId: id, time: p.time, label: str(p.label, 'Alarm'), repeat: str(p.repeat, 'once'), enabled: true } };
  },
  set_reminder: p => {
    need(validTime(p.time), 'Reminder time must be HH:MM (24-hour)');
    const id = rid('rem_');
    return { providerRef: id, result: { reminderId: id, time: p.time, text: str(p.text, 'Reminder'), enabled: true } };
  }
};
