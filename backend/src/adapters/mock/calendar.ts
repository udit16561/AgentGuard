import { list, need, rid, str, type MockTool } from './util';

const people = (p: Record<string, unknown>) => list(p.attendees).filter(a => !['you', 'me', 'self'].includes(a.toLowerCase()));
const link = (id: string) => `https://calendar.agentguard.mock/event/${id}`;

/** Google Calendar, simulated: attendees start as "needsAction" and get invitation emails. */
export const calendar: MockTool = {
  view: () => ({ providerRef: rid('cal-view-'), result: { events: [
    { eventId: 'evt_standup', title: 'Team stand-up', start: '10:00', end: '10:15' },
    { eventId: 'evt_lunch', title: 'Lunch with Raj', start: '13:00', end: '14:00' }
  ] } }),
  create: p => {
    need(str(p.title) || str(p.start), 'An event needs a title or a start time');
    const id = rid('evt_');
    const attendees = people(p).map(email => ({ email, responseStatus: 'needsAction' }));
    return { providerRef: id, result: { eventId: id, htmlLink: link(id), title: str(p.title, 'Untitled event'), start: p.start ?? null, end: p.end ?? null, attendees, invitationsSent: attendees.length } };
  },
  invite: p => {
    const id = str(p.eventId) || rid('evt_');
    return { providerRef: id, result: { eventId: id, added: people(p), invitationsSent: people(p).length, htmlLink: link(id) } };
  },
  update: p => {
    need(str(p.eventId), 'Which event? eventId is missing');
    const updated = Object.keys(p).filter(k => k !== 'eventId');
    return { providerRef: str(p.eventId), result: { eventId: p.eventId, updated, invitationsSent: people(p).length, htmlLink: link(str(p.eventId)) } };
  },
  cancel: p => {
    need(str(p.eventId), 'Which event? eventId is missing');
    return { providerRef: str(p.eventId), result: { eventId: p.eventId, status: 'cancelled', cancellationsSent: people(p).length } };
  }
};
