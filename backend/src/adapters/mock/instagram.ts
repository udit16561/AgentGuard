import { list, need, rid, str, type MockTool } from './util';

/** Instagram Graph API, simulated. */
export const instagram: MockTool = {
  read_feed: () => ({ providerRef: rid('ig-read-'), result: { posts: [{ mediaId: 'ig_1', caption: 'Weekend hike', likes: 128 }] } }),
  read_insights: () => ({ providerRef: rid('ig-read-'), result: { reach7d: 4210, followers: 1830 } }),
  post: p => {
    need(list(p.media).length || str(p.caption), 'A post needs media or a caption');
    const id = rid('ig_');
    return { providerRef: id, result: { mediaId: id, permalink: `https://instagram.agentguard.mock/p/${id}`, caption: str(p.caption), media: list(p.media) } };
  },
  story: p => {
    need(list(p.media).length, 'A story needs media');
    const id = rid('igs_');
    return { providerRef: id, result: { storyId: id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } };
  },
  comment: p => {
    need(str(p.text), 'Comment text is empty');
    const id = rid('igc_');
    return { providerRef: id, result: { commentId: id, postId: str(p.postId) } };
  },
  dm: p => {
    need(list(p.to).length, 'Who should get this message?');
    const id = rid('igdm_');
    return { providerRef: id, result: { messageId: id, to: list(p.to) } };
  }
};
