import { list, need, rid, str, type MockTool } from './util';

const wamid = () => `wamid.${rid('', 12).toUpperCase()}`;

/** WhatsApp Business Cloud API, simulated: one message id per recipient, status "sent". */
export const whatsapp: MockTool = {
  read_chats: () => ({ providerRef: rid('wa-read-'), result: { chats: [{ with: '+91-mom', last: 'Reaching at 8?', unread: 1 }, { with: 'Team', last: 'Deploy done', unread: 0 }] } }),
  send_message: p => {
    const to = list(p.to);
    need(to.length, 'WhatsApp needs at least one recipient');
    need(str(p.text), 'Message text is empty');
    const messages = to.map(r => ({ id: wamid(), to: r, status: 'sent' }));
    return { providerRef: messages[0].id, result: { messages } };
  },
  send_media: p => {
    const to = list(p.to);
    need(to.length, 'WhatsApp needs at least one recipient');
    const media = list(p.media);
    need(media.length, 'No media attached');
    const messages = to.map(r => ({ id: wamid(), to: r, status: 'sent' }));
    return { providerRef: messages[0].id, result: { messages, media } };
  }
};
