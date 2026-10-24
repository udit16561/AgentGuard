import { digits, list, need, rid, str, type MockTool } from './util';

const MAX = 280;
const text = (p: Record<string, unknown>) => {
  const t = str(p.text);
  need(t, 'Post text is empty');
  need(t.length <= MAX, `Text exceeds ${MAX} characters`);
  return t;
};

/** X (Twitter) API v2, simulated: snowflake-style ids and the 280-character limit. */
export const x: MockTool = {
  read_timeline: () => ({ providerRef: rid('x-read-'), result: { posts: [{ tweetId: '1850000000000000001', text: 'Shipping day!' }] } }),
  post: p => {
    const t = text(p), id = digits(19);
    return { providerRef: id, result: { tweetId: id, url: `https://x.agentguard.mock/i/status/${id}`, text: t } };
  },
  reply: p => {
    const t = text(p), id = digits(19);
    return { providerRef: id, result: { tweetId: id, inReplyTo: str(p.postId) || null, url: `https://x.agentguard.mock/i/status/${id}`, text: t } };
  },
  repost: p => {
    need(str(p.postId), 'Which post? postId is missing');
    const id = digits(19);
    return { providerRef: id, result: { repostId: id, of: p.postId } };
  },
  dm: p => {
    need(list(p.to).length, 'Who should get this message?');
    need(str(p.text), 'Message text is empty');
    const id = rid('dm_');
    return { providerRef: id, result: { dmEventId: id, to: list(p.to) } };
  }
};
