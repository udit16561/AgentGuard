import { digits, list, need, rid, str, type MockTool } from './util';

/** LinkedIn, simulated: shares and messages are identified by URNs. */
export const linkedin: MockTool = {
  read_profile: () => ({ providerRef: rid('li-read-'), result: { name: 'Demo User', headline: 'Product at Example', connections: 512 } }),
  read_feed: () => ({ providerRef: rid('li-read-'), result: { posts: [{ urn: 'urn:li:share:7000000000000000001', text: 'We are hiring!' }] } }),
  post: p => {
    need(str(p.text), 'Post text is empty');
    const urn = `urn:li:share:${digits(19)}`;
    return { providerRef: urn, result: { urn, url: `https://www.linkedin.agentguard.mock/feed/update/${urn}`, visibility: str(p.audience, 'PUBLIC').toUpperCase() } };
  },
  message: p => {
    need(list(p.to).length, 'Who should get this message?');
    const urn = `urn:li:message:${digits(19)}`;
    return { providerRef: urn, result: { messageUrn: urn, to: list(p.to) } };
  },
  connect: p => {
    need(list(p.to).length, 'Who should get the invitation?');
    const id = rid('li-inv-');
    return { providerRef: id, result: { invitationId: id, status: 'PENDING', note: str(p.note) } };
  }
};
