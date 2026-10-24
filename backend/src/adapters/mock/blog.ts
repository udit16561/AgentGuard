import crypto from 'node:crypto';
import { need, rid, str, type MockTool } from './util';

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'post';

/** A headless CMS, simulated: posts get a public URL and a revision number. */
export const blog: MockTool = {
  list_drafts: () => ({ providerRef: rid('blog-read-'), result: { drafts: [{ postId: 'post_draft1', title: 'Q3 update (draft)', updatedAt: '2026-10-20' }] } }),
  publish: p => {
    const title = str(p.title);
    need(title, 'A post needs a title');
    const id = rid('post_');
    return { providerRef: id, result: { postId: id, url: `https://blog.agentguard.mock/${slug(title)}`, revision: 1, status: 'published' } };
  },
  edit_live: p => {
    need(str(p.postId), 'Which post? postId is missing');
    return { providerRef: str(p.postId), result: { postId: p.postId, revision: 2 + crypto.randomInt(5), status: 'published' } };
  },
  delete: p => {
    need(str(p.postId), 'Which post? postId is missing');
    return { providerRef: str(p.postId), result: { postId: p.postId, status: 'deleted' } };
  }
};
