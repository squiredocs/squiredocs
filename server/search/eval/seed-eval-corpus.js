#!/usr/bin/env node
/**
 * Seed a deterministic evaluation corpus (feature 018 US4 support tooling).
 *
 * The curated eval set (eval-set.json) references concrete document UUIDs.
 * This script creates that corpus — fixed UUIDs, fixed content — in whatever
 * database DATABASE_URL points at, so the committed DRAFT set is reproducible
 * end-to-end by anyone (implementer sandbox today; Sam can also run it in a
 * scratch DB to sanity-check the harness before re-curating the set against
 * the real operator-dev corpus — that re-curation is the owed step recorded
 * in the promotion notes).
 *
 * Usage:
 *   DATABASE_URL=postgresql://...:5432/collab_eval_db_018 node server/search/eval/seed-eval-corpus.js
 *
 * The target DB must exist and be migrated (npm run migrate). Idempotent:
 * re-running replaces the seeded docs.
 */
require('dotenv').config();

const { Pool } = require('pg');
const Y = require('yjs');
const { PostgresPersistence } = require('../../postgres-persistence');

const EVAL_USER_ID = 'e0180000-0000-4000-8000-00000000c0de';
const EVAL_USER_EMAIL = 'search-eval-operator@example.com';

// Fixed doc UUIDs — referenced verbatim by eval-set.json.
const D = (n) => `d0180000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const h = (level, text) => ({ h: level, text });

/**
 * The corpus: a realistic mix — long structured docs (runbooks, postmortems,
 * specs, compiled notes → multi-chunk), and short self-situating docs
 * (checklists, policies → single-chunk). Vocabulary deliberately overlaps
 * across documents so paraphrase/conceptual queries are actually hard.
 */
const CORPUS = [
  {
    id: D(1),
    title: 'Kubernetes Upgrade Runbook',
    blocks: [
      h(1, 'Kubernetes Upgrade Runbook'),
      'This runbook covers moving the production cluster between minor versions with zero downtime. Read the whole document before starting; the ordering of the steps matters and skipping the preflight section has caused trouble twice. The window for an upgrade is Tuesday morning after the traffic trough, and the on-call engineer must be present for the entire procedure.',
      h(2, 'Preflight checks'),
      'Confirm that every workload has a PodDisruptionBudget and that no Deployment is mid-rollout. Take an etcd snapshot and copy it off the control plane host; verify the snapshot with etcdutl before proceeding. Check the deprecation report for removed APIs — anything still using a removed API version must be patched first. Announce the window in the operations channel, silence the alert routes that fire on node cordons, and double-check that the container registry mirror is reachable from every node, because a cold registry during rotation extends the window badly.',
      h(2, 'Control plane upgrade'),
      'Upgrade one control plane node at a time: cordon it, apply the new kubeadm bundle, and wait for the static pods to settle before touching the next node. Watch the API server error rate between each step — a sustained rise above baseline means stop and investigate, not push through. After the last control plane node, upgrade the cluster addons (CoreDNS, kube-proxy, the CNI) in that order. Record the versions in the change log as you go; the drift between recorded and actual versions is what made the January audit painful.',
      h(2, 'Node pool rotation'),
      'Rotate workers in batches of three: cordon, drain with a ten minute grace period, replace the machine image, and uncordon once the kubelet reports Ready. Stateful workloads pin to the slow batch — drain those nodes one at a time and give the operators time to fail volumes over cleanly. Autoscaling stays disabled until the last batch, otherwise the autoscaler fights the drain.',
      h(2, 'Reverting a release'),
      'If a workload misbehaves after the upgrade, the fastest path back is restoring the previous manifest revision from the change log and letting the rollout controller converge. For a control plane regression, restore the etcd snapshot taken in preflight onto the first node, then rejoin the remaining nodes against it. Never restore a snapshot taken after the upgrade started. Practice this path during restore drills — the muscle memory is the difference between a five minute blip and an afternoon outage.',
    ],
  },
  {
    id: D(2),
    title: 'Incident Postmortem: March Storage Outage',
    blocks: [
      h(1, 'Incident Postmortem: March Storage Outage'),
      'Severity 1, four hours of degraded writes on the primary database volume, no data loss. Written by the on-call pair, reviewed in the operations sync. Blameless — the process gaps are the finding, not the people.',
      h(2, 'Timeline'),
      'At 02:10 the write latency alert fired for the primary volume. At 02:25 the on-call engineer identified the volume at 97 percent capacity and began pruning old WAL segments. At 03:05 capacity crossed 100 percent despite pruning and the database went read-only. At 04:40 an emergency volume expansion completed and writes resumed. At 06:10 the backlog of queued writes finished draining and latency returned to baseline.',
      h(2, 'Root cause'),
      'A debug flag left enabled after the February load test caused verbose query logging on every request. The resulting log accumulation grew at roughly forty gigabytes per day and nothing alerted on the growth rate — only on absolute capacity, which fired far too late for a volume this size. The pruning job that should have caught it considers only application logs, not database logs, a split nobody remembered.',
      h(2, 'Remediation'),
      'The debug flag now has a time-to-live and the deploy pipeline refuses to promote a build with it enabled. Capacity alerting switched from absolute thresholds to growth-rate projection with a three day horizon. The pruning job was rewritten to cover every log producer on the volume, and a quarterly audit of disk consumers was added to the operations calendar. A restore drill against the March snapshot confirmed the backup path was never at risk.',
    ],
  },
  {
    id: D(3),
    title: 'Incident Postmortem: May Login Failures',
    blocks: [
      h(1, 'Incident Postmortem: May Login Failures'),
      'Severity 2, ninety minutes during which most users were unable to authenticate. Sessions already issued kept working, which limited the blast radius to people returning after the morning.',
      h(2, 'Timeline'),
      'At 09:12 support flagged a spike in reports of failed authentication. At 09:20 the on-call engineer confirmed that token issuance was erroring while token validation still passed. At 09:48 the root cause was identified and a replacement was deployed. At 10:41 error rates returned to zero and support confirmed users could get in again.',
      h(2, 'Root cause'),
      'The signing certificate used to mint session tokens expired at 09:00. The certificate had been provisioned manually eighteen months earlier, outside the automation that renews every other certificate in the fleet, so no expiry alert existed for it. Validation kept succeeding because the old public key remained in the trust bundle — only issuance of new sessions failed, which is why the failure looked partial and confusing at first.',
      h(2, 'Remediation'),
      'The signing certificate moved under the same automated renewal as the rest of the fleet, with alerts at thirty and seven days before expiry. An inventory sweep found two more manually provisioned certificates, both now automated. The authentication service also gained a startup check that refuses to boot with a certificate expiring within seven days, converting a silent future outage into a loud deploy-time failure.',
    ],
  },
  {
    id: D(4),
    title: 'Search Quality Redesign',
    blocks: [
      h(1, 'Search Quality Redesign'),
      'Design notes for making content retrieval trustworthy. The core complaint from users and from the in-app assistant is the same: a document that plainly discusses a topic does not come back when you ask about that topic in your own words.',
      h(2, 'Problems today'),
      'The index splits documents into fixed-size windows that ignore structure, so a window often mixes the end of one section with the start of the next and embeds as a muddle of both. Nothing records which headings a passage lives under, so a passage deep in a long document carries no hint of its context. Titles are matched by keyword but never embedded, so conceptual queries that echo a title miss on the semantic side entirely.',
      h(2, 'Proposed chunking approach'),
      'Split along heading boundaries into pieces sized for the embedding model, each carrying its trail of ancestor headings with the document title at the head. Give every piece of a longer document a short generated preamble situating it in the whole, and index that preamble for both engines. Keep single-piece documents bare — they already say what they are, and skipping them removes most of the generation cost.',
      h(2, 'Evaluation plan'),
      'A curated query set with paraphrased, multi-document, and unanswerable entries, hard enough that configurations score differently on it. One command re-indexes per configuration and prints recall, reciprocal rank, and gain-discounted relevance side by side. The previous machine-drafted set saturated — every configuration aced it — which taught us that an evaluation that cannot say no proves nothing.',
    ],
  },
  {
    id: D(5),
    title: 'Onboarding Flow Specification',
    blocks: [
      h(1, 'Onboarding Flow Specification'),
      'What a brand new account experiences between signup and their first shared document. The goal is a first session that ends with something real created, not a tour.',
      h(2, 'First-run experience'),
      'After the welcome screen, the workspace opens directly into a seeded example document the person can edit immediately — no modal sequence, no checklist overlay. The example document teaches by being editable: headings, a table, and a comment thread are already present, and the first keystroke replaces placeholder text. A dismissible side rail offers three short tasks; finishing any one of them marks the account activated.',
      h(2, 'Empty states'),
      'Every list in the product needs a designed empty state: the document list suggests creating or importing, the shared-with-me view explains how sharing works before anything is shared, and search with no results proposes broadening the query rather than showing a blank pane. Empty states never dead-end; each one carries exactly one primary action.',
      h(2, 'Activation metrics'),
      'Activation is defined as creating one document and sharing it within the first week. The funnel is instrumented at signup, first edit, first share, and first return visit; each step emits one event with no content payload. Weekly review looks at drop-off between steps rather than absolute counts, because the absolute numbers are dominated by invite waves.',
    ],
  },
  {
    id: D(6),
    title: 'Weekly Sync Notes - Q2 Compilation',
    blocks: [
      h(1, 'Weekly Sync Notes - Q2 Compilation'),
      'Rolling notes from the Monday sync, compiled quarterly so decisions are findable after the fact. Newest month last.',
      h(2, 'April'),
      'Decided to bring on a product designer as the next hire, ahead of a second backend engineer — the interface debt is now the bottleneck. Agreed the mobile web experience is good enough for the beta and a native app stays out of scope for the year. The importer bug backlog was triaged: three data-loss adjacent issues fixed within the week, the cosmetic ones batched for later.',
      h(2, 'May'),
      'Postponed all billing and payments work until after the public beta; the free tier carries us through the year and the integration effort was crowding out retention work. Chose to consolidate observability on the managed stack instead of self-hosting the collectors. The May authentication incident consumed one sync entirely — actions are tracked in the postmortem, not here.',
      h(2, 'June'),
      'Adopted trunk-based development with feature branches only for genuinely exploratory work; the long-lived branch experiment from spring created two painful merges and no upside. Committed to a quarterly restore drill after the storage postmortem action review. Sketched the offsite agenda and settled on Lisbon as the venue after comparing costs.',
    ],
  },
  {
    id: D(7),
    title: 'Data Retention and Backup Policy',
    blocks: [
      h(1, 'Data Retention and Backup Policy'),
      'What we keep, for how long, and how we prove we can get it back. This policy is reviewed twice a year and after any storage incident.',
      h(2, 'What we keep'),
      'Documents and their full edit history are kept for the life of the account plus thirty days after deletion, to allow recovery from mistakes. Application logs are kept for thirty days, access logs for ninety, and anonymized usage aggregates for two years. Support conversation transcripts are kept for one year. Nothing else is retained; in particular, raw request bodies are never written to durable storage.',
      h(2, 'Snapshot cadence'),
      'The primary database takes an automated snapshot every night and a full logical export every Sunday. Snapshots are copied to a second region within the hour and the copies are immutable for their whole retention window — a compromised control plane cannot shorten or delete them. Nightly snapshots are kept for fourteen days, weekly exports for ninety.',
      h(2, 'Restore drills'),
      'Once a quarter, a randomly chosen snapshot is restored into a scratch environment and a checklist of integrity probes runs against it: row counts against the source watermark, a sample of document histories replayed end to end, and one full account export compared field by field. The drill is timed, and the time-to-restore trend is reported in the operations review. A drill that fails any probe opens a severity 2 incident regardless of production impact.',
    ],
  },
  {
    id: D(8),
    title: 'Customer Feedback Digest - Spring',
    blocks: [
      h(1, 'Customer Feedback Digest - Spring'),
      'A quarterly synthesis of what users told us through support, interviews, and the in-app prompt. Direct quotes are paraphrased for anonymity.',
      h(2, 'Praise'),
      'Real-time collaboration is the headline: people repeatedly described editing together as the reason they switched. The version history browser earned unprompted love from three separate teams, particularly the ability to name a version before a risky rewrite. Import fidelity from markdown came up positively in almost every interview with a technical team.',
      h(2, 'Complaints'),
      'Large exports are slow — several people described starting an export and walking away to make coffee. The sharing model confuses first-timers: the difference between sharing a document and inviting someone to the workspace is not obvious, and two customers created duplicate accounts trying. A handful of users hit the session limit on shared machines and found the error message unhelpful.',
      h(2, 'Requests'),
      'The most requested capability is an offline mode for trains and flights, mentioned by nine customers. Document templates came second — teams want to stamp out meeting notes and design docs with their own structure. Third was a public read-only link that does not require any account, for sharing with clients outside the workspace.',
    ],
  },

  // ——— Short, self-situating documents (single-chunk) ———
  {
    id: D(9),
    title: 'Deploy Checklist',
    blocks: [
      h(1, 'Deploy Checklist'),
      'Confirm the change log entry exists and links the pull request. Run the full test suite and the smoke test against staging. Check that no migration in the release requires a maintenance window. Ship during the morning trough, watch the error dashboard for fifteen minutes, and only then mark the release done in the tracker. If anything looks off, revert first and investigate second.',
    ],
  },
  {
    id: D(10),
    title: 'Hiring Rubric for Backend Engineers',
    blocks: [
      h(1, 'Hiring Rubric for Backend Engineers'),
      'Four interviews, each scored one to four against written anchors: a coding exercise on realistic data handling, a system design interview centered on evolving a schema under load, a debugging session inside an unfamiliar codebase, and a values conversation with someone from another function. A candidate needs no score below two and at least two threes to advance to references. We weight the debugging session highest — it predicts day-to-day work far better than whiteboard design.',
    ],
  },
  {
    id: D(11),
    title: 'Travel Policy',
    blocks: [
      h(1, 'Travel Policy'),
      'Book flights at least two weeks out where possible and prefer refundable fares for anything crossing a quarter boundary. The per diem covers meals and local transit; accommodation is booked through the agency portal so invoices reconcile automatically. Client-facing trips need no approval below a thousand euros total; everything else needs a one-line note to the operations channel before booking.',
    ],
  },
  {
    id: D(12),
    title: 'Team Offsite Plan - Lisbon',
    blocks: [
      h(1, 'Team Offsite Plan - Lisbon'),
      'Three days in Lisbon in late September. Day one is the product roadmap working session, day two pairs people across functions on prototypes, day three is unstructured with an optional tram tour. The venue is a rented studio near the river with reliable wifi and a courtyard. Flights follow the travel policy; the studio and group dinners come out of the offsite budget line, not individual expenses.',
    ],
  },
  {
    id: D(13),
    title: 'Reading List',
    blocks: [
      h(1, 'Reading List'),
      'Currently circulating in the team library: a book on writing that argues clarity is a moral quality, a systems classic about how complex systems fail, a short volume on interviewing users without leading them, and a paper collection on collaborative editing algorithms. Add your own with a one-line reason; remove anything that has sat unclaimed for a quarter.',
    ],
  },
  {
    id: D(14),
    title: 'Garden Journal - June',
    blocks: [
      h(1, 'Garden Journal - June'),
      'The tomatoes finally set fruit after the cold snap, and the basil bolted the moment I stopped watching it. Moved the rosemary into the bigger terracotta pot and it perked up within the week. Note for next year: the north bed gets less light than it looks like it does in April, so the peppers go on the balcony rail instead.',
    ],
  },
  {
    id: D(15),
    title: 'API Token Rotation Guide',
    blocks: [
      h(1, 'API Token Rotation Guide'),
      'Service credentials rotate on a ninety day cycle. Mint the replacement token first, deploy it alongside the old one, verify traffic on the new credential in the dashboard, and only then revoke the old token — never revoke first. Personal access tokens for scripts follow the same overlap pattern manually. The rotation calendar lives in the operations wiki; the on-call engineer owns any rotation that falls in their week.',
    ],
  },
  {
    id: D(16),
    title: 'Meeting Room AV Guide',
    blocks: [
      h(1, 'Meeting Room AV Guide'),
      'The big room screen takes the USB-C cable directly for anything modern; the HDMI adapter in the drawer covers everything else. If the screen shows no signal, power-cycle it from the switch behind the left speaker, not the remote. The conference microphone pairs automatically once the room calendar shows a call starting; if it fails, the wired fallback is in the same drawer as the adapter.',
    ],
  },
  {
    id: D(17),
    title: 'Expense Reporting Howto',
    blocks: [
      h(1, 'Expense Reporting Howto'),
      'Photograph the receipt the day you get it and drop it into the expenses folder with the trip or purchase name. Submit the report within two weeks of the spend; anything older needs a note explaining the delay. Reimbursement lands with the next payroll run after approval. Card statements alone are not receipts — the itemized slip is what the auditors want.',
    ],
  },
  {
    id: D(18),
    title: 'Release Naming Conventions',
    blocks: [
      h(1, 'Release Naming Conventions'),
      'Releases are named after rivers, alphabetically within a year: Amstel, Brahmaputra, Congo. The name marks a marketing-visible milestone; ordinary weekly ships carry only their version number. A river name is chosen at the planning sync when the milestone is cut, and the change log groups everything under that name until the milestone ships.',
    ],
  },
  {
    id: D(19),
    title: 'Support Escalation Contacts',
    blocks: [
      h(1, 'Support Escalation Contacts'),
      'First line is the support rotation in the shared inbox. Anything touching data integrity or security goes straight to the on-call engineer via the paging service, day or night. Billing disputes above five hundred euros go to operations. Press or legal inquiries go only to the founders — never answer those from the support queue, even to acknowledge.',
    ],
  },
  {
    id: D(20),
    title: 'Database Connection Pooling Notes',
    blocks: [
      h(1, 'Database Connection Pooling Notes'),
      'The application keeps one shared connection pool per process, sized at twice the CPU count after the March benchmarking session. Transactions must be short — hold a client only for the query, never across an external call. The session-level statement timeout is thirty seconds; long maintenance jobs opt out explicitly rather than raising the global limit. Pool exhaustion shows up as queue-time spikes in the dashboard before it shows up as errors, so alert on the former.',
    ],
  },
  {
    id: D(21),
    title: 'Brand Voice Guidelines',
    blocks: [
      h(1, 'Brand Voice Guidelines'),
      'We write like a knowledgeable colleague, not a mascot: plain sentences, no exclamation marks in product copy, and jokes only where failure is impossible. Error messages say what happened and what to do next, in that order, without apologizing twice. Feature announcements lead with what the reader can now do, never with how hard we worked.',
    ],
  },
  {
    id: D(22),
    title: 'Quarterly OKRs - Q3 Draft',
    blocks: [
      h(1, 'Quarterly OKRs - Q3 Draft'),
      'Objective one: make retention visible and improving — weekly active editors up, first-week activation up, and the top two spring complaints (export speed and sharing confusion) measurably addressed. Objective two: operational calm — every alert actionable, restore drill passed, zero severity 1 incidents. Objective three: ship the collaboration template gallery requested in the feedback digest, with usage instrumented from day one.',
    ],
  },
  {
    id: D(23),
    title: 'Coffee Machine Maintenance',
    blocks: [
      h(1, 'Coffee Machine Maintenance'),
      'Descaling happens on the first Monday of the month with the citric solution under the sink — run two full tanks of plain water after. The grinder burrs get brushed out every Friday. If the pressure gauge sits in the red zone at idle, turn the machine off and message the office channel; do not run a shot through it to test.',
    ],
  },
  {
    id: D(24),
    title: 'SSH Access Cheatsheet',
    blocks: [
      h(1, 'SSH Access Cheatsheet'),
      'Production hosts accept keys only through the bastion; direct SSH is refused everywhere. Your key ships to the bastion via the access repo — open a pull request adding your public key and an expiry date, and access appears within the hour of merge. Sessions are recorded. For the hardened cluster, use the operator kubeconfig flow in the deployment docs instead; SSH there is emergency-only.',
    ],
  },
];

function buildYDoc(title, blocks) {
  const ydoc = new Y.Doc();
  ydoc.getMap('meta').set('title', title);
  const frag = ydoc.getXmlFragment('default');
  const els = blocks.map((b) => {
    if (typeof b === 'string') {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(b)]);
      return p;
    }
    const el = new Y.XmlElement('heading');
    el.setAttribute('level', String(b.h));
    el.insert(0, [new Y.XmlText(b.text)]);
    return el;
  });
  frag.insert(0, els);
  return ydoc;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL to the target (migrated) eval database.');
    process.exit(1);
  }
  const dbConfig = { connectionString: process.env.DATABASE_URL };
  const pool = new Pool(dbConfig);
  const persistence = new PostgresPersistence(dbConfig, { statementTimeout: false });
  await persistence._init();

  try {
    await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES ($1, $2, $3, 'Search Eval Operator')
       ON CONFLICT (id) DO NOTHING`,
      [EVAL_USER_ID, `eval-018-${EVAL_USER_ID}`, EVAL_USER_EMAIL]
    );

    for (const doc of CORPUS) {
      // Replace any previous seeding of this doc wholesale.
      await pool.query('DELETE FROM document_embeddings WHERE doc_id = $1', [doc.id]);
      await pool.query('DELETE FROM document_search_index WHERE doc_id = $1', [doc.id]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [doc.id]);
      await persistence.clearDocument(doc.id).catch(() => {});
      await pool.query('DELETE FROM documents WHERE id = $1', [doc.id]);

      await pool.query(
        'INSERT INTO documents (id, title, creator_id) VALUES ($1, $2, $3)',
        [doc.id, doc.title, EVAL_USER_ID]
      );
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [doc.id, EVAL_USER_ID]
      );
      const ydoc = buildYDoc(doc.title, doc.blocks);
      await persistence.storeUpdate(doc.id, Y.encodeStateAsUpdate(ydoc), EVAL_USER_ID);
      console.log(`seeded ${doc.id}  ${doc.title}`);
    }
    console.log(`\n${CORPUS.length} documents seeded for user ${EVAL_USER_ID} (${EVAL_USER_EMAIL}).`);
    console.log('Next: npm run search:eval (it re-indexes per variant itself).');
  } finally {
    await persistence.destroy().catch(() => {});
    await pool.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { CORPUS, EVAL_USER_ID };
