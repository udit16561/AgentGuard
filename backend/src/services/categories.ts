/** Payment categories a user can block (docs/PREFERENCES.md §payments). */
/** Words that suggest a payment category when the agent did not name one (raises risk only). */
export const CATEGORY_WORDS: Record<string, RegExp> = {
  gambling: /\b(gambl\w*|bet(s|ting)?|casino|poker|lottery|jackpot|rummy|wager\w*|slots?)\b/i,
  crypto: /\b(crypto\w*|bitcoin|btc|ethereum|eth|usdt|binance|wazirx|blockchain|nft|token sale)\b/i,
  'gift cards': /\b(gift ?cards?|vouchers?|gift codes?|itunes card|google play card)\b/i,
  alcohol: /\b(alcohol|liquor|wine|beer|whisk(e)?y|vodka|bar tab)\b/i,
  adult: /\b(adult|xxx|escort)\b/i
};
export const categoryHit = (category: string, text: string) => {
  const words = CATEGORY_WORDS[category.toLowerCase()] ?? CATEGORY_WORDS[category.toLowerCase().replace(/s$/, '')];
  return words ? words.test(text) : new RegExp(`\\b${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
};
