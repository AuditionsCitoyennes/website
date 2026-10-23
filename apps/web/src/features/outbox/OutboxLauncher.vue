<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, ApiError } from "@/shared/api/client";
import { outboxAddresses, outboxNudge, outboxViewer } from "@/shared/api/outbox";
import ModalDialog from "@/shared/ui/dialog/ModalDialog.vue";
import { useAuthStore } from "@/features/auth";

// The test outbox: on staging and in local development the API sends no
// email, it keeps them (EMAIL_MODE=outbox), and they are read here — the
// witness's verification email, the sign-up confirmation… links clickable.
// "Mine" is what this browser's actions sent, and what was sent to its
// signed-in user or to an address typed into its auth forms; "Tous", every
// tester's. The button shows only where the API keeps an outbox.

interface EmailSummary {
  id: string;
  created_at: string;
  source: string;
  recipients: string[];
  subject: string;
  viewer: string | null;
  user_id: string | null;
}

interface Email extends EmailSummary {
  body_html: string | null;
  body_text: string | null;
}

type Scope = "mine" | "all";

const SCOPE_KEY = "ac-outbox-scope";
const SEEN_KEY = "ac-outbox-seen";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* forgotten at the next visit */
  }
}

const auth = useAuthStore();

const available = ref(false);
const emails = ref<EmailSummary[]>([]);
const open = ref(false);
const scope = ref<Scope>(readStored(SCOPE_KEY) === "all" ? "all" : "mine");
const seenAt = ref(readStored(SEEN_KEY) ?? "");
const selected = ref<Email | null>(null);
const selecting = ref<string | null>(null);
const failed = ref(false);

watch(scope, (s) => store(SCOPE_KEY, s));

async function refresh() {
  try {
    const res = await api.get<{ emails: EmailSummary[] }>("/api/outbox");
    emails.value = res.emails;
    available.value = true;
    failed.value = false;
  } catch (e) {
    // 404: this API keeps no outbox (production, or another email mode).
    if (e instanceof ApiError && e.status === 404) available.value = false;
    else failed.value = true;
  }
}

/** "Name <a@b.c>" or "a@b.c" → "a@b.c", lowercased. */
function addressOf(recipient: string): string {
  const angled = /<([^>]+)>/.exec(recipient);
  return (angled ? angled[1] : recipient).trim().toLowerCase();
}

const myAddresses = computed(() => {
  // Read again whenever the list is: an auth form may have added one.
  void emails.value;
  const set = new Set(outboxAddresses());
  if (auth.user?.email) set.add(auth.user.email.toLowerCase());
  return set;
});

function isMine(e: EmailSummary): boolean {
  if (e.viewer === outboxViewer()) return true;
  if (auth.user && e.user_id === auth.user.id) return true;
  return e.recipients.some((r) => myAddresses.value.has(addressOf(r)));
}

const mine = computed(() => emails.value.filter(isMine));
const shown = computed(() => (scope.value === "mine" ? mine.value : emails.value));
const unseen = computed(() => mine.value.filter((e) => e.created_at > seenAt.value).length);

function markSeen() {
  const newest = emails.value[0]?.created_at;
  if (newest && newest > seenAt.value) {
    seenAt.value = newest;
    store(SEEN_KEY, newest);
  }
}

async function openOutbox() {
  open.value = true;
  await refresh();
  markSeen();
}

function close() {
  open.value = false;
  selected.value = null;
}

async function select(e: EmailSummary) {
  selecting.value = e.id;
  try {
    selected.value = await api.get<Email>(`/api/outbox/${e.id}`);
  } catch {
    selected.value = null;
    failed.value = true;
  } finally {
    selecting.value = null;
  }
}

// While open, what arrives is seen.
watch(emails, () => {
  if (open.value) markSeen();
});

/** The email as sent, its links opening in a new tab (the outbox stays). */
const srcdoc = computed(() => {
  const html = selected.value?.body_html;
  if (!html) return null;
  const base = '<base target="_blank">';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
});

const SOURCES: Record<string, string> = {
  api: "Site",
  "auth:signup": "Inscription",
  "auth:recovery": "Mot de passe",
  "auth:magiclink": "Connexion",
  "auth:email": "Connexion",
  "auth:invite": "Invitation",
  "auth:email_change": "Changement d'adresse",
  "auth:reauthentication": "Code",
};

function sourceLabel(source: string): string {
  return SOURCES[source] ?? source;
}

const relative = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const full = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" });

function ago(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return "à l'instant";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86400), "day");
}

// Looks again when something this browser did may have sent an email (a
// moment later: the request has just answered), when the tab comes back, and
// every 30 seconds while it is shown — never once this API has no outbox.
let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
watch(outboxNudge, () => {
  if (!available.value) return;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(refresh, 400);
});

function onFocus() {
  if (available.value) void refresh();
}

const poll = setInterval(() => {
  if (available.value && document.visibilityState === "visible") void refresh();
}, 30_000);

onMounted(() => {
  void refresh();
  window.addEventListener("focus", onFocus);
});

onBeforeUnmount(() => {
  clearTimeout(nudgeTimer);
  clearInterval(poll);
  window.removeEventListener("focus", onFocus);
});
</script>

<template>
  <button
    v-if="available"
    type="button"
    class="outbox-launcher"
    :aria-label="unseen ? `Emails de test, ${unseen} nouveau(x)` : 'Emails de test'"
    @click="openOutbox"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
    <span class="outbox-launcher-label">Emails de test</span>
    <span v-if="unseen" class="outbox-badge">{{ unseen }}</span>
  </button>

  <ModalDialog
    :open="open"
    title="Emails de test"
    description="Ce que le site aurait envoyé. Rien n'est parti : ces emails n'existent qu'ici."
    dismissible
    wide
    :view-key="selected ? 'email' : 'list'"
    @close="close"
  >
    <div class="outbox" :class="{ 'outbox--reading': selected }">
      <section class="outbox-list" aria-label="Emails">
        <div class="outbox-scope" role="group" aria-label="Afficher">
          <button
            type="button"
            :aria-pressed="scope === 'mine'"
            :class="{ active: scope === 'mine' }"
            @click="scope = 'mine'"
          >
            Les miens <span class="outbox-count">{{ mine.length }}</span>
          </button>
          <button
            type="button"
            :aria-pressed="scope === 'all'"
            :class="{ active: scope === 'all' }"
            @click="scope = 'all'"
          >
            Tous <span class="outbox-count">{{ emails.length }}</span>
          </button>
        </div>

        <p v-if="failed" class="outbox-note outbox-note--error">
          La boîte n'a pas pu être lue. Réessayez dans un instant.
        </p>
        <p v-if="shown.length === 0" class="outbox-note">
          <template v-if="scope === 'mine'">
            Rien pour l'instant. Déposez un témoignage, créez un compte : les emails que vos actions
            envoient arrivent ici.
            <button v-if="emails.length" type="button" class="outbox-link" @click="scope = 'all'">
              Voir ceux des autres testeurs
            </button>
          </template>
          <template v-else>Aucun email pour l'instant.</template>
        </p>

        <ul v-else class="outbox-items">
          <li v-for="e in shown" :key="e.id">
            <button
              type="button"
              class="outbox-item"
              :class="{ current: selected?.id === e.id, loading: selecting === e.id }"
              @click="select(e)"
            >
              <span class="outbox-item-subject">{{ e.subject }}</span>
              <span class="outbox-item-to">À : {{ e.recipients.join(", ") }}</span>
              <span class="outbox-item-meta">
                <span class="chip chip--outline">{{ sourceLabel(e.source) }}</span>
                <span v-if="scope === 'all' && isMine(e)" class="chip">Vous</span>
                <time :datetime="e.created_at" :title="full.format(new Date(e.created_at))">
                  {{ ago(e.created_at) }}
                </time>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <section class="outbox-reader" aria-label="Email">
        <template v-if="selected">
          <button
            type="button"
            class="ac-btn ac-btn--ghost ac-btn--sm outbox-back"
            @click="selected = null"
          >
            ← Tous les emails
          </button>
          <dl class="outbox-head">
            <dt>Objet</dt>
            <dd class="outbox-head-subject">{{ selected.subject }}</dd>
            <dt>À</dt>
            <dd>{{ selected.recipients.join(", ") }}</dd>
            <dt>Envoyé</dt>
            <dd>{{ full.format(new Date(selected.created_at)) }}</dd>
          </dl>
          <iframe
            v-if="srcdoc"
            class="outbox-frame"
            :srcdoc="srcdoc"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer"
            title="Contenu de l'email"
          />
          <pre v-else class="outbox-text">{{ selected.body_text }}</pre>
        </template>
        <p v-else class="outbox-note outbox-placeholder">Choisissez un email pour le lire.</p>
      </section>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* A test tool, not part of the site: amber, so nobody takes it for a feature. */
.outbox-launcher {
  position: fixed;
  left: 1rem;
  bottom: calc(2.5rem + env(safe-area-inset-bottom, 0px));
  z-index: 1400;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  height: 2.5rem;
  padding: 0 0.9rem;
  border-radius: 999px;
  border: 1px dashed hsl(38 80% 50% / 0.8);
  background: hsl(var(--card));
  color: hsl(38 90% 40%);
  font-size: var(--text-ui);
  font-weight: 600;
  box-shadow: var(--shadow-lg);
  cursor: pointer;
}

:global(.dark) .outbox-launcher {
  color: hsl(38 90% 60%);
}

.outbox-launcher:hover {
  background: hsl(38 80% 50% / 0.1);
}

.outbox-badge {
  min-width: 1.35rem;
  height: 1.35rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-size: var(--text-caption);
  line-height: 1.35rem;
  text-align: center;
}

.outbox {
  display: grid;
  grid-template-columns: minmax(0, 17rem) minmax(0, 1fr);
  gap: 1.25rem;
  min-height: min(32rem, calc(100dvh - 12rem));
}

.outbox-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

.outbox-scope {
  display: flex;
  padding: 0.2rem;
  border-radius: 0.6rem;
  background: hsl(var(--muted));
}

.outbox-scope button {
  flex: 1;
  height: 2rem;
  border: 0;
  border-radius: 0.45rem;
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: var(--text-ui);
  font-weight: 600;
  cursor: pointer;
}

.outbox-scope button.active {
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  box-shadow: var(--shadow-sm);
}

.outbox-count {
  font-size: var(--text-caption);
  opacity: 0.7;
}

.outbox-items {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: min(32rem, calc(100dvh - 16rem));
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}

.outbox-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: 1px solid hsl(var(--border));
  border-radius: 0.6rem;
  background: hsl(var(--card));
  color: hsl(var(--foreground));
  text-align: left;
  cursor: pointer;
}

.outbox-item:hover {
  background: hsl(var(--accent) / 0.5);
}

.outbox-item.current {
  border-color: hsl(var(--primary));
  background: hsl(var(--accent));
}

.outbox-item.loading {
  opacity: 0.6;
}

.outbox-item-subject {
  font-size: var(--text-ui);
  font-weight: 600;
}

.outbox-item-to {
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
  overflow-wrap: anywhere;
}

.outbox-item-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--text-caption);
  color: hsl(var(--muted-foreground));
}

.outbox-reader {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

.outbox-back {
  display: none;
  align-self: flex-start;
}

.outbox-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.2rem 0.75rem;
  margin: 0;
  font-size: var(--text-ui);
}

.outbox-head dt {
  color: hsl(var(--muted-foreground));
}

.outbox-head dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.outbox-head-subject {
  font-weight: 600;
}

/* The email's own colours, whatever the site's theme: a white page. */
.outbox-frame {
  flex: 1;
  width: 100%;
  min-height: 26rem;
  border: 1px solid hsl(var(--border));
  border-radius: 0.6rem;
  background: #fff;
}

.outbox-text {
  margin: 0;
  padding: 1rem;
  border-radius: 0.6rem;
  background: hsl(var(--muted));
  font-family: var(--font-sans);
  font-size: var(--text-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.outbox-note {
  margin: 0;
  font-size: var(--text-ui);
  color: hsl(var(--muted-foreground));
}

.outbox-note--error {
  color: hsl(var(--destructive));
}

.outbox-placeholder {
  margin: auto;
}

.outbox-link {
  display: block;
  margin-top: 0.5rem;
  padding: 0;
  border: 0;
  background: none;
  color: hsl(var(--primary));
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

/* Phones: the list, or the email open — one at a time. */
@media (max-width: 719px) {
  .outbox {
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
  }

  .outbox-launcher-label {
    display: none;
  }

  .outbox--reading .outbox-list,
  .outbox:not(.outbox--reading) .outbox-reader {
    display: none;
  }

  .outbox-back {
    display: inline-flex;
  }

  .outbox-items {
    max-height: none;
  }

  .outbox-frame {
    min-height: 60dvh;
  }
}
</style>
