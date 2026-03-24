import { useMemo, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Copy,
  LifeBuoy,
  Search,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';

type HelpSection =
  | 'all'
  | 'quick_start'
  | 'monitoring'
  | 'actions'
  | 'key_management'
  | 'security'
  | 'diagnostics'
  | 'faq'
  | 'glossary';

type HelpArticle = {
  id: string;
  title: string;
  section: Exclude<HelpSection, 'all' | 'faq' | 'glossary'>;
  summary: string;
  whenToUse: string;
  steps: string[];
  verify: string[];
  warnings?: string[];
  nextActions?: string[];
  tags: string[];
  docPath?: string;
};

type FaqItem = {
  id: string;
  question: string;
  answer: string;
  tags: string[];
};

type GlossaryTerm = {
  term: string;
  definition: string;
  tags: string[];
};

type ChecklistItem = {
  id: string;
  title: string;
  description: string;
};

const CHECKLIST_STORAGE_KEY = 'beaconcha_help_checklist_v1';

const SECTION_LABELS: Record<HelpSection, string> = {
  all: 'All',
  quick_start: 'Quick Start',
  monitoring: 'Monitoring',
  actions: 'Action Center',
  key_management: 'Key Mgmt',
  security: 'Security',
  diagnostics: 'Diagnostics',
  faq: 'FAQ',
  glossary: 'Glossary',
};

const SECTION_ORDER: HelpSection[] = [
  'all',
  'quick_start',
  'monitoring',
  'actions',
  'key_management',
  'security',
  'diagnostics',
  'faq',
  'glossary',
];

const CHECKLIST_ITEMS: ChecklistItem[] = [
  {
    id: 'daemon_running',
    title: 'Daemon reachable',
    description: 'Checked `/status`, no `DAEMON_TIMEOUT` errors.',
  },
  {
    id: 'validator_resolved',
    title: 'Validator confirmed',
    description: 'Index/pubkey matches the expected operator record.',
  },
  {
    id: 'inventory_verified',
    title: 'Inventory verified',
    description: 'Status, withdrawal type, and balances match chain reality.',
  },
  {
    id: 'rpc_health_checked',
    title: 'RPC health verified',
    description: 'At least one Beacon and one Execution endpoint have score >= 70.',
  },
  {
    id: 'alerts_tested',
    title: 'Telegram test completed',
    description: 'Heartbeat/digest/incident messages received without duplication.',
  },
  {
    id: 'ops_dryrun_done',
    title: 'Action dry-run completed',
    description: 'Eligibility and signer model were verified for the key operation.',
  },
  {
    id: 'keymanager_backup',
    title: 'Slashing protection backup',
    description: 'Slashing protection was exported before key move/delete.',
  },
  {
    id: 'lock_policy_set',
    title: 'Access lock configured',
    description: 'Auto-lock timeout is set and manual lock/unlock is verified.',
  },
];

const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'quick-start-core',
    title: 'First launch of Beaconcha Tools',
    section: 'quick_start',
    summary:
      'How to start daemon + desktop UI correctly, complete onboarding, and enter the dashboard without timeouts.',
    whenToUse: 'New instance, clean machine, or after full profile RESET.',
    steps: [
      'Copy `config/beaconops.example.toml` to `config/beaconops.toml` and configure at least 2 Beacon + 2 Execution endpoints.',
      'Start daemon: `cargo run -p beaconops-daemon -- --config config/beaconops.toml` and ensure port `127.0.0.1:8742` is free.',
      'In a second terminal, start desktop: `cd apps/desktop && npm run tauri:dev`.',
      'On the startup window, wait for required checks to finish: daemon/cache/config.',
      'At the identity step, enter validator index or pubkey and press Verify.',
      'Create a local password (used only for UI lock/unlock).',
      'Press Next and wait until the imported validator is synchronized with the dashboard.',
    ],
    verify: [
      'Dashboard shows the expected validator index and correct pubkey.',
      '`Health` has at least one endpoint with score >= 70 for Beacon and Execution.',
      'No `DAEMON_TIMEOUT` modal appears on manual `Refresh now`.',
    ],
    warnings: [
      'If daemon is already running, repeated start returns `Address already in use`.',
      'Without a valid Beacon endpoint, onboarding verify may fail with `VALIDATOR_NOT_FOUND`.',
    ],
    nextActions: [
      'Open `Monitoring` and verify inventory.',
      'Open `Settings` and configure auto-lock.',
      'Connect Telegram in config for alerts.',
    ],
    tags: ['onboarding', 'daemon', 'startup', 'access', 'timeout'],
    docPath: 'docs/quick-start.md',
  },
  {
    id: 'quick-start-multi-validator',
    title: 'How to add and switch multiple validators',
    section: 'quick_start',
    summary:
      'Import multiple validators into runtime without losing current context and with predictable UI updates.',
    whenToUse: 'When you need to monitor more than one validator in the same app.',
    steps: [
      'In the left rail add block, enter index/pubkey of the next validator.',
      'Wait for import cycle completion and automatic dashboard refresh.',
      'Use the validator selector in the rail to switch context.',
      'After switching, wait for refresh indicator completion; do not submit ops while update is running.',
      'Repeat for the remaining validators.',
    ],
    verify: [
      'In dashboard, `Tracked validators` is > 1.',
      'On switching, index/pubkey/status values change consistently.',
      'Incidents are filtered by the active validator.',
    ],
    warnings: [
      'If the data source is degraded, switching may take longer.',
    ],
    tags: ['inventory', 'switch', 'multi-validator', 'rail'],
    docPath: 'docs/user-guide.md',
  },
  {
    id: 'monitoring-inventory',
    title: 'How to read Validator Inventory',
    section: 'monitoring',
    summary:
      'Inventory is the core operational view: lifecycle, balances, withdrawal credentials, and eligibility actions.',
    whenToUse: 'Daily validator control and operation preparation.',
    steps: [
      'Check `status`: active/pending/exiting/exited/slashed.',
      'Check `withdrawal credentials type`: 0x00/0x01/0x02.',
      'Verify `withdrawal address` against the expected custody wallet.',
      'Compare `current balance` and `effective balance` to assess yield and constraints.',
      'Review `Queue`: activation/exit state and ETA.',
      'Check `Action eligibility` chips and the `Why blocked` block.',
    ],
    verify: [
      'No validator has unexpected status/slashed flag.',
      'For a planned action (for example convert), eligibility shows `Eligible`.',
      'Queue ETA reflects real lifecycle state (pending/exiting).',
    ],
    tags: ['inventory', 'lifecycle', 'credentials', 'eligibility'],
    docPath: 'docs/user-guide.md',
  },
  {
    id: 'monitoring-duties-rewards',
    title: 'Duties and Rewards: how not to miss issues',
    section: 'monitoring',
    summary:
      'Practical control of proposer/sync duties, missed attestations, and balance dynamics.',
    whenToUse: 'Operational monitoring during the day and before maintenance windows.',
    steps: [
      'In `Duties`, check `Next proposal`, ETA, and safe maintenance window.',
      'In `Rewards`, monitor delta 1h/24h/7d and missed attestation streak.',
      'If streak grows, open `Health` and inspect endpoint latency/failures.',
      'Correlate incident timestamps with RPC/network failure windows.',
      'After fixes, run `Refresh now` and confirm metrics stabilize.',
    ],
    verify: [
      'No MISSED_ATTESTATION spikes when endpoint score is stable.',
      'Rewards curve keeps updating and does not freeze on an old timestamp.',
      'Safe maintenance window does not conflict with expected proposer slot.',
    ],
    tags: ['duties', 'rewards', 'missed', 'proposer', 'sync'],
    docPath: 'docs/runbooks.md',
  },
  {
    id: 'actions-bls-change',
    title: '0x00 -> 0x01: safe flow',
    section: 'actions',
    summary:
      'Procedure for BLS-to-execution change with dry-run, signer checks, and Beacon API submission.',
    whenToUse: 'When validator withdrawal credentials type is `0x00`.',
    steps: [
      'Open `Operations` -> `0x00 -> 0x01 BLS change`.',
      'Fill validator index, from BLS pubkey, and target execution address.',
      'Paste BLS withdrawal private key only for the duration of the operation.',
      'Run `Dry run` first and verify signature/domain/signing root.',
      'If dry-run is correct, disable dry-run and submit.',
      'Immediately after operation, clear sensitive data from clipboard.',
    ],
    verify: [
      'Preflight shows no block by credentials type.',
      'Result shows `submitted=true` for live submission.',
      'After network confirmation, credentials type changes to `0x01`.',
    ],
    warnings: [
      'Never store BLS keys in the app or shared notes.',
      'If pubkey does not match chain record, operation must be stopped.',
    ],
    nextActions: ['After credentials change, check eligibility for convert/consolidate.'],
    tags: ['0x00', '0x01', 'bls_change', 'signing', 'withdrawal'],
    docPath: 'docs/operator-guide.md',
  },
  {
    id: 'actions-convert-exit-withdraw',
    title: 'EL actions: convert, consolidate, exit, partial withdraw',
    section: 'actions',
    summary:
      'Unified flow for execution-layer actions via preflight and signed raw transaction.',
    whenToUse: 'Operations for validators with 0x01/0x02 credentials.',
    steps: [
      'Select action in the `Execution-layer actions` form.',
      'Set source validator index; for consolidate set target validator index.',
      'For partial withdraw, enter amount ETH so at least 32 ETH remains after withdrawal.',
      'Run dry-run preflight and verify `eligible` + `preflight_reason`.',
      'Sign tx with external wallet/signer/SAFE and paste `raw_transaction`.',
      'Submit with dry-run=off.',
    ],
    verify: [
      'For consolidate, target validator has credentials type 0x02.',
      'For partial withdraw, preflight does not return post-withdraw < 32 ETH.',
      'Live submit returns tx hash.',
    ],
    warnings: [
      'Invalid raw tx can cause irreversible on-chain consequences.',
      'Before submit, validate gas strategy and correct chain/network.',
    ],
    tags: ['convert', 'consolidate', 'top-up', 'exit', 'partial-withdraw'],
    docPath: 'docs/api-contracts.md',
  },
  {
    id: 'actions-consensus-exit',
    title: 'Consensus voluntary exit (fallback)',
    section: 'actions',
    summary:
      'Fallback path via validator signing key when EL-trigger flow is not used.',
    whenToUse: 'Planned voluntary exit via consensus path.',
    steps: [
      'Open `Consensus voluntary exit` block.',
      'Set validator index and validator pubkey.',
      'Set epoch (or leave empty for current epoch).',
      'Run dry-run first, then submit.',
      'Track status transition to exiting/exited on dashboard.',
    ],
    verify: [
      'Validator is active and not slashed.',
      'Activation window check does not block submit.',
      'Incidents show no voluntary-exit submission errors.',
    ],
    warnings: ['Use only a valid validator signing key for this path.'],
    tags: ['consensus_exit', 'fallback', 'validator_key'],
    docPath: 'docs/operator-guide.md',
  },
  {
    id: 'keymanager-setup',
    title: 'Keymanager API setup',
    section: 'key_management',
    summary:
      'Connect validator client endpoints for list/import/delete keystores and remote signer keys.',
    whenToUse: 'Custody integration and key management via standard Keymanager API.',
    steps: [
      'Add `[keymanager].endpoints` to `config/beaconops.toml`.',
      'Set `auth_token` for protected endpoints.',
      'Restart daemon and open the `Key Mgmt` tab.',
      'Check endpoint list, then test list keystores/remotekeys.',
      'Run import/delete only after slashing protection backup.',
    ],
    verify: [
      '`KEYMANAGER_NOT_CONFIGURED` error is absent.',
      'Endpoint selection works and returns records.',
      'Mutation result reflects applied status per endpoint.',
    ],
    warnings: ['Never delete keys without prior slashing protection backup.'],
    tags: ['keymanager', 'keystore', 'remote signer', 'custody'],
    docPath: 'docs/operator-guide.md',
  },
  {
    id: 'keymanager-safe-move',
    title: 'Safe move of keys between validator clients',
    section: 'key_management',
    summary:
      'Recommended procedure for key migration without slashing risk.',
    whenToUse: 'Migrating validators between VC/infra instances.',
    steps: [
      'Put source VC in a safe state: ensure there is no duplicate run.',
      'Export slashing protection interchange from source.',
      'Import keystore + slashing protection to target endpoint.',
      'Verify keys are active only on target.',
      'Delete keys on source only after successful migration verification.',
    ],
    verify: [
      'No parallel signing by the same validator on two VCs.',
      'Slashing protection data is successfully imported on target.',
      'Incidents show no anomalies after migration.',
    ],
    warnings: [
      'Running the same active key on two clients simultaneously increases slashing risk.',
    ],
    tags: ['safe-move', 'slashing-protection', 'migration'],
    docPath: 'docs/runbooks.md',
  },
  {
    id: 'security-baseline',
    title: 'Security baseline for operators',
    section: 'security',
    summary:
      'Minimum mandatory security rules for production operations.',
    whenToUse: 'Baseline hardening setup before long-term operation.',
    steps: [
      'Store validator signing keys and withdrawal secrets in separate custody domains.',
      'Do not paste private keys into live flows unless necessary and only briefly.',
      'Restrict daemon API access to loopback and host firewall.',
      'Enable lock policy and a short auto-lock timeout in Settings.',
      'Check client updates before network upgrades.',
    ],
    verify: [
      'Telemetry/crash reporting are disabled unless explicit opt-in is provided.',
      'Secrets are not stored in plain-text config or logs.',
      'System locks on timeout and unlocks correctly.',
    ],
    tags: ['security', 'hardening', 'custody', 'lock'],
    docPath: 'docs/operator-guide.md',
  },
  {
    id: 'security-incident-ready',
    title: 'Incident readiness: what to do during degradation',
    section: 'security',
    summary:
      'Short response flow for critical events and network issues.',
    whenToUse: 'When runtime mode = degraded, incidents increase, or duty/reward metrics drop.',
    steps: [
      'Open `Health` and find endpoints with score < 35.',
      'Switch or remove unstable RPC from the pool.',
      'Run `Manual retry`, then monitor chain/execution head recovery.',
      'Check `Incidents` by timestamp and reason.',
      'If issue repeats, save diagnostics and open an issue.',
    ],
    verify: [
      'Runtime mode returned to healthy.',
      'No new critical incidents of the same type.',
      'Dashboard metrics refresh without long freezes.',
    ],
    tags: ['incident', 'degraded', 'rpc', 'runbook'],
    docPath: 'docs/incident-playbooks.md',
  },
  {
    id: 'diag-daemon-timeout',
    title: 'Troubleshooting: DAEMON_TIMEOUT / DAEMON_UNREACHABLE',
    section: 'diagnostics',
    summary:
      'Step-by-step diagnostics when UI does not receive a response from local daemon.',
    whenToUse: 'Modal with `DAEMON_TIMEOUT` or `DAEMON_UNREACHABLE` in UI.',
    steps: [
      'Verify daemon process is running and listening on `127.0.0.1:8742`.',
      'If port is busy, stop the old process and restart only one daemon.',
      'Check `GET /api/v1/status` with curl and ensure JSON is returned.',
      'Verify UI base URL: it must point to `.../api/v1`.',
      'Open `Open logs` and inspect latest RPC errors/timeouts.',
    ],
    verify: [
      '`Refresh now` completes cycle without error.',
      'Startup daemon/config checks pass in the gate window.',
    ],
    warnings: ['Parallel launch of multiple daemons on the same port causes instability.'],
    tags: ['daemon_timeout', 'unreachable', 'port', 'status'],
    docPath: 'docs/failure-scenarios.md',
  },
  {
    id: 'diag-rpc-keymanager-errors',
    title: 'Troubleshooting: HTTP_404 and KEYMANAGER_NOT_CONFIGURED',
    section: 'diagnostics',
    summary:
      'Why UI gets API 404 and how to enable Keymanager routes correctly.',
    whenToUse: '`HTTP_404`, `KEYMANAGER_NOT_CONFIGURED` errors in Operations/Key Mgmt tabs.',
    steps: [
      'Ensure the current daemon binary from this repository is running.',
      'If route returns 404, restart daemon via `cargo run` in project root.',
      'For Keymanager, add endpoints in `[keymanager]` and restart daemon.',
      'Check `GET /api/v1/keymanager/endpoints`: it should return endpoint list.',
      'If endpoint is protected, verify `auth_token` correctness.',
    ],
    verify: [
      'Key Mgmt tab shows endpoint selector and key record lists.',
      'Mutation result returns applied statuses instead of config errors.',
    ],
    tags: ['http_404', 'keymanager', 'routes', 'config'],
    docPath: 'docs/api-contracts.md',
  },
  {
    id: 'diag-incidents-interpretation',
    title: 'How to interpret Incident Stream',
    section: 'diagnostics',
    summary:
      'Interpret severities, codes, and next actions without false alarms.',
    whenToUse: 'Analyze warnings and critical events in timeline.',
    steps: [
      'Check severity first: critical > warning > info.',
      'Open code/details and verify technical reason.',
      'Correlate event with runtime refresh time and endpoint health.',
      'Check whether incident is isolated or repeating by fingerprint.',
      'Run remediation by runbook based on incident code.',
    ],
    verify: [
      'After remediation, repeated incident frequency decreases.',
      'Incidents are not duplicated inside Telegram anti-spam window.',
    ],
    tags: ['incidents', 'severity', 'fingerprint', 'timeline'],
    docPath: 'docs/incident-playbooks.md',
  },
];

const FAQ_ITEMS: FaqItem[] = [
  {
    id: 'faq-no-values',
    question: 'Why can some metrics be 0 or temporarily unavailable?',
    answer:
      'Usually this is caused by public RPC degradation, timeouts, or a short window without fresh snapshots. Check Health score, then run Manual retry.',
    tags: ['metrics', 'zero', 'rpc', 'retry'],
  },
  {
    id: 'faq-daemon-restart',
    question: 'Will data be lost after restart?',
    answer:
      'Snapshot/incidents/state history is stored in SQLite (WAL), so data persists across normal restart. Temporary caches are rebuilt.',
    tags: ['restart', 'sqlite', 'durability'],
  },
  {
    id: 'faq-keys-storage',
    question: 'Does the app store private keys?',
    answer:
      'In production, keys should not be stored inside the app. Use external signer / wallet custody and only short-lived manual input.',
    tags: ['security', 'keys', 'custody'],
  },
  {
    id: 'faq-quiet-hours',
    question: 'Why was a warning not sent to Telegram immediately?',
    answer:
      'During quiet hours, warning-level incidents are grouped into digest. Critical incidents are sent immediately. Configure this in `[telegram]`.',
    tags: ['telegram', 'quiet-hours', 'digest'],
  },
  {
    id: 'faq-keymanager-error',
    question: 'What does KEYMANAGER_NOT_CONFIGURED mean?',
    answer:
      '`[keymanager].endpoints` is not set in daemon config. Add endpoint(s), set auth_token if needed, and restart daemon.',
    tags: ['keymanager', 'config'],
  },
];

const GLOSSARY: GlossaryTerm[] = [
  {
    term: 'Withdrawal credentials 0x00',
    definition: 'Legacy BLS withdrawal credentials. Transition requires BLS-to-execution change.',
    tags: ['credentials', '0x00', 'bls'],
  },
  {
    term: 'Withdrawal credentials 0x01',
    definition: 'Execution address credentials with auto-sweep of excess above 32 ETH.',
    tags: ['credentials', '0x01', 'execution'],
  },
  {
    term: 'Withdrawal credentials 0x02',
    definition: 'Compounding validator credentials for higher effective-balance scenarios.',
    tags: ['credentials', '0x02', 'compounding'],
  },
  {
    term: 'EL full exit',
    definition: 'Exit initiated by execution-layer transaction through withdrawal wallet.',
    tags: ['exit', 'execution', 'withdrawal-wallet'],
  },
  {
    term: 'Consensus voluntary exit',
    definition: 'Legacy CL exit path via validator signing key/validator client.',
    tags: ['exit', 'consensus', 'validator-key'],
  },
  {
    term: 'RPC health score',
    definition: 'Composite indicator of endpoint reliability (latency/failures/success).',
    tags: ['rpc', 'health', 'failover'],
  },
  {
    term: 'Failover active',
    definition: 'Requests moved to fallback endpoint due to primary endpoint degradation.',
    tags: ['failover', 'rpc'],
  },
  {
    term: 'Slashing protection',
    definition: 'Protection from double-signing. Must be migrated with keys.',
    tags: ['slashing', 'key-management', 'safety'],
  },
];

function loadChecklistState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CHECKLIST_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveChecklistState(state: Record<string, boolean>) {
  try {
    localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore localStorage write issues in restricted runtimes.
  }
}

function articleSearchBlob(article: HelpArticle): string {
  return [
    article.title,
    article.summary,
    article.whenToUse,
    article.tags.join(' '),
    article.steps.join(' '),
    article.verify.join(' '),
    article.warnings?.join(' ') ?? '',
    article.nextActions?.join(' ') ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function faqSearchBlob(item: FaqItem): string {
  return `${item.question} ${item.answer} ${item.tags.join(' ')}`.toLowerCase();
}

function glossarySearchBlob(item: GlossaryTerm): string {
  return `${item.term} ${item.definition} ${item.tags.join(' ')}`.toLowerCase();
}

function articleToClipboardText(article: HelpArticle): string {
  const lines = [
    article.title,
    '',
    article.summary,
    '',
    `When to use: ${article.whenToUse}`,
    '',
    'Steps:',
    ...article.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    'Result checks:',
    ...article.verify.map((item, index) => `${index + 1}. ${item}`),
  ];

  if (article.warnings?.length) {
    lines.push('', 'Important warnings:', ...article.warnings.map((item) => `- ${item}`));
  }

  if (article.nextActions?.length) {
    lines.push('', 'Next actions:', ...article.nextActions.map((item) => `- ${item}`));
  }

  if (article.docPath) {
    lines.push('', `External documentation: ${article.docPath}`);
  }

  return lines.join('\n');
}

export default function HelpCenter() {
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<HelpSection>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [checklistState, setChecklistState] = useState<Record<string, boolean>>(
    () => loadChecklistState()
  );

  const normalizedQuery = query.trim().toLowerCase();

  const filteredArticles = useMemo(() => {
    return HELP_ARTICLES.filter((article) => {
      if (section !== 'all' && section !== article.section) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return articleSearchBlob(article).includes(normalizedQuery);
    });
  }, [normalizedQuery, section]);

  const filteredFaq = useMemo(() => {
    if (section !== 'all' && section !== 'faq') {
      return [];
    }
    return FAQ_ITEMS.filter((item) => {
      if (!normalizedQuery) {
        return true;
      }
      return faqSearchBlob(item).includes(normalizedQuery);
    });
  }, [normalizedQuery, section]);

  const filteredGlossary = useMemo(() => {
    if (section !== 'all' && section !== 'glossary') {
      return [];
    }
    return GLOSSARY.filter((item) => {
      if (!normalizedQuery) {
        return true;
      }
      return glossarySearchBlob(item).includes(normalizedQuery);
    });
  }, [normalizedQuery, section]);

  const checklistDone = CHECKLIST_ITEMS.filter((item) => checklistState[item.id]).length;
  const checklistTotal = CHECKLIST_ITEMS.length;
  const hasAnyResult =
    filteredArticles.length > 0 || filteredFaq.length > 0 || filteredGlossary.length > 0;

  const toggleChecklist = (id: string) => {
    setChecklistState((current) => {
      const next = {
        ...current,
        [id]: !current[id],
      };
      saveChecklistState(next);
      return next;
    });
  };

  const copyArticle = async (article: HelpArticle) => {
    try {
      await navigator.clipboard.writeText(articleToClipboardText(article));
      setCopiedId(article.id);
      setTimeout(() => {
        setCopiedId((current) => (current === article.id ? null : current));
      }, 1400);
    } catch {
      // Clipboard may be unavailable in restricted runtimes.
    }
  };

  return (
    <section className="help-center">
      <header className="help-center__header">
        <div className="help-center__title">
          <BookOpen size={17} />
          <h2>User Help Center</h2>
        </div>
        <p>
          Detailed instructions for onboarding, monitoring, operations, security, and diagnostics.
        </p>
      </header>

      <section className="help-checklist">
        <header>
          <div>
            <small>First-run checklist</small>
            <strong>
              {checklistDone}/{checklistTotal} completed
            </strong>
          </div>
          <ClipboardList size={16} />
        </header>

        <div className="help-checklist__items">
          {CHECKLIST_ITEMS.map((item) => (
            <label key={item.id} className="help-checklist__item">
              <input
                type="checkbox"
                checked={Boolean(checklistState[item.id])}
                onChange={() => toggleChecklist(item.id)}
              />
              <span>
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="help-center__toolbar">
        <div className="help-sections" role="tablist" aria-label="Help sections">
          {SECTION_ORDER.map((sectionId) => (
            <button
              key={sectionId}
              type="button"
              className={section === sectionId ? 'is-active' : ''}
              onClick={() => setSection(sectionId)}
            >
              {SECTION_LABELS[sectionId]}
            </button>
          ))}
        </div>

        <label className="help-search">
          <Search size={14} />
          <input
            type="search"
            placeholder="Search by steps, errors, codes, and terms"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </section>

      <section className="help-center__stats">
        <span>
          <CheckCircle2 size={14} />
          Runbooks: {filteredArticles.length}
        </span>
        <span>
          <LifeBuoy size={14} />
          FAQ: {filteredFaq.length}
        </span>
        <span>
          <ShieldCheck size={14} />
          Glossary: {filteredGlossary.length}
        </span>
      </section>

      <div className="help-center__list">
        {filteredArticles.map((article) => (
          <article key={article.id} className="help-article">
            <header>
              <div>
                <small>{SECTION_LABELS[article.section]}</small>
                <h3>{article.title}</h3>
              </div>
              <button type="button" onClick={() => void copyArticle(article)}>
                <Copy size={14} />
                {copiedId === article.id ? 'Copied' : 'Copy'}
              </button>
            </header>

            <p>{article.summary}</p>
            <p className="help-article__when">
              <strong>When to use:</strong> {article.whenToUse}
            </p>

            <div className="help-article__columns">
              <section>
                <h4>
                  <TerminalSquare size={14} />
                  Steps
                </h4>
                <ol>
                  {article.steps.map((step, index) => (
                    <li key={`${article.id}-step-${index}`}>{step}</li>
                  ))}
                </ol>
              </section>

              <section>
                <h4>
                  <CheckCircle2 size={14} />
                  Result checks
                </h4>
                <ul>
                  {article.verify.map((item, index) => (
                    <li key={`${article.id}-verify-${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            </div>

            {article.warnings?.length ? (
              <section className="help-article__warnings">
                <h4>Important warnings</h4>
                <ul>
                  {article.warnings.map((item, index) => (
                    <li key={`${article.id}-warning-${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {article.nextActions?.length ? (
              <section className="help-article__next">
                <h4>Next actions</h4>
                <ul>
                  {article.nextActions.map((item, index) => (
                    <li key={`${article.id}-next-${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <footer>
              <span className="help-tags">
                {article.tags.map((tag) => (
                  <code key={`${article.id}-${tag}`}>{tag}</code>
                ))}
              </span>
              {article.docPath ? <small>Docs: {article.docPath}</small> : null}
            </footer>
          </article>
        ))}

        {filteredFaq.length ? (
          <section className="help-faq">
            <header>
              <h3>FAQ</h3>
            </header>
            <div className="help-faq__list">
              {filteredFaq.map((item) => (
                <article key={item.id}>
                  <h4>{item.question}</h4>
                  <p>{item.answer}</p>
                  <span className="help-tags">
                    {item.tags.map((tag) => (
                      <code key={`${item.id}-${tag}`}>{tag}</code>
                    ))}
                  </span>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {filteredGlossary.length ? (
          <section className="help-glossary">
            <header>
              <h3>Glossary</h3>
            </header>
            <div className="help-glossary__list">
              {filteredGlossary.map((item) => (
                <article key={item.term}>
                  <h4>{item.term}</h4>
                  <p>{item.definition}</p>
                  <span className="help-tags">
                    {item.tags.map((tag) => (
                      <code key={`${item.term}-${tag}`}>{tag}</code>
                    ))}
                  </span>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {!hasAnyResult ? (
          <div className="empty-state">
            No results found. Refine the query (for example: `DAEMON_TIMEOUT`, `0x01 -&gt; 0x02`,
            `keymanager`, `slashing protection`).
          </div>
        ) : null}
      </div>
    </section>
  );
}
