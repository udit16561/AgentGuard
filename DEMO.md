# AgentGuard demo (10 minutes, no API keys)

## Before you start
- `git clone https://github.com/udit16561/AgentGuard.git && cd AgentGuard && npm install`
- `npm run db:seed`: creates the demo user (Pro plan, all 9 tools in MOCK mode, pending alerts, offline Assistant).
- `npm run dev`: the self-check should end with "100% usable with no API keys".
- Open **http://localhost:4000** and sign in as **demo@agentguard.dev / Demo#12345**.
- Seeded alerts expire after 10 minutes; run `npm run db:seed` again for fresh ones.

## The script
1. **Dashboard:** you see "Waiting for your decision" with a count, the kill switch, recent actions and spend against caps. The sidebar says **MOCK mode**.
2. **Assistant → type `pay Ravi 500` → Send:** the agent proposes a payment; a card shows **Payments · Pay**, a risk badge and "Nothing happens until you approve it".
3. **The alert:** the **Review** badge in the menu goes up by one, and the new payment is at the top of **Dashboard → Needs your decision**.
4. **Click "Review it":** the Review screen shows the **payment receipt preview** ("Not paid yet"), the exact details, the **Intent and risk** card (risk level, flags and why), and an expiry countdown. Approve and Reject are the same size, and neither is selected.
5. **Click Approve… → enter `Demo#12345` if asked → Approve:** the status goes **Approved → Submitted → Completed (confirmed)**, with a MOCK provider reference.
6. **Assistant → type `pay Ravi 5000` → Send:** the card says **Blocked**: "It is over your daily cap" (₹2,000 a day). Nothing is sent and there is nothing to approve.
7. **Review → All → open "Pay ₹5,000.00 (INR) to Ravi":** a red note explains in plain words: "Blocked: it is over your daily cap. It cannot run, and nothing was sent."
8. **Review → open "Post on LinkedIn, publicly":** **Critical risk**, and the **Preference check** says it **breaks** your "Nothing about politics" rule. Click **Reject** and add a reason: the status turns to **Rejected**.
9. **Dashboard → Pause all agents:** a **PAUSED** banner shows on every screen. In the Assistant, `pay Ravi 100` is refused: "The kill switch is on".
10. **Click "Resume agents"** in the banner: the banner goes away, and agents can propose again.
11. **Audit → Verify:** the timeline lists every proposal, decision, block, the kill switch and the result, and Verify says **Chain intact**.
12. **Optional, Tools:** each tool card says MOCK. Calendar shows "Live: not configured", which is optional and needs no keys.
