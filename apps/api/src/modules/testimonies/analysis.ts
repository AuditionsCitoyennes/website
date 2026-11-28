import { ANALYSIS_MODEL, AUDITION_THEMES, themesOf } from "@ac/shared";
import { config } from "../../config";
import { AnswerTooLargeError, upstreamFetch } from "../../lib/cappedFetch";

// Thematic analysis of testimonies via Claude — ported from the previous
// analyze-audition edge function (same model, prompt, parameters).
//
// The model reads a text anyone may have written, so its answer is taken for
// what it is asked to be and nothing more: read within a size limit, never
// through a redirect, and only the themes of the grid are kept of it
// (AUDITION_THEMES: 16 at most, each once) — whatever else the answer holds,
// and however much of it, is dropped before anything is stored.

export class AnalysisDisabledError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY n'est pas configuré. Ajoutez votre clé API Anthropic dans la configuration du serveur.",
    );
    this.name = "AnalysisDisabledError";
  }
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

const SYSTEM_PROMPT = `Tu es un analyste expert de témoignages citoyens dans le contexte politique et social français. Ton rôle est d'identifier avec précision les thèmes abordés dans chaque témoignage.

## Instructions
- Analyse le témoignage dans son ensemble, pas uniquement les mots-clés.
- Identifie les thèmes explicites ET implicites (par exemple, quelqu'un qui parle de "fins de mois difficiles" aborde le pouvoir d'achat même sans utiliser ce terme).
- Un témoignage peut correspondre à plusieurs thèmes, sans limite.
- Ne retourne que les thèmes réellement abordés ou discutés, pas ceux simplement mentionnés en passant.

## Thèmes possibles (utilise UNIQUEMENT ceux-ci, avec l'orthographe exacte)

- "Santé et accès aux soins" : accès aux hôpitaux, déserts médicaux, coût des médicaments, santé mentale, handicap, système de santé
- "Éducation" : système scolaire, enseignants, universités, formation professionnelle, moyens des écoles, programmes scolaires
- "Emploi et conditions de travail" : chômage, précarité, burn-out, salaires, droit du travail, conditions de travail
- "Logement" : loyers, crise du logement, sans-abrisme, logement social, immobilier, mal-logement
- "Pouvoir d'achat et inflation" : coût de la vie, prix, pouvoir d'achat, difficultés financières des ménages, fins de mois
- "Retraites" : réforme des retraites, âge de départ, montant des pensions, système de retraite
- "Justice sociale et inégalités" : écarts de richesse, discriminations, pauvreté, mobilité sociale, égalité des chances
- "Démocratie et institutions" : élections, représentativité, participation citoyenne, confiance en la politique, corruption, vie politique
- "Médias et information" : presse, désinformation, réseaux sociaux, confiance dans les médias, liberté de la presse
- "Sécurité et police" : délinquance, violences policières, système judiciaire, prison, sécurité du quotidien
- "Immigration" : migrants, intégration, asile, frontières, politique migratoire
- "Environnement et écologie" : climat, pollution, biodiversité, transition énergétique, agriculture, pesticides
- "Guerre et géopolitique" : conflits internationaux, politique étrangère, défense, paix, diplomatie
- "Services publics" : poste, transports, services administratifs, dégradation des infrastructures publiques, hôpital public
- "Fiscalité" : impôts, justice fiscale, dépenses publiques, budget de l'État, dette publique
- "Culture et loisirs" : arts, sport, patrimoine, vie associative, vie de quartier, accès à la culture

## Format de sortie
Retourne UNIQUEMENT un tableau JSON valide contenant les thèmes identifiés, sans aucun texte avant ou après.

## Exemples

Témoignage : "Je suis infirmière et je vois chaque jour les urgences déborder. On manque de personnel, les patients attendent des heures. Et avec mon salaire, je n'arrive même plus à payer mon loyer."
Réponse : ["Santé et accès aux soins", "Services publics", "Emploi et conditions de travail", "Logement", "Pouvoir d'achat et inflation"]

Témoignage : "On ne peut plus faire confiance aux politiques. Ils promettent et ne font rien. Les médias ne montrent que ce qu'ils veulent."
Réponse : ["Démocratie et institutions", "Médias et information"]

Témoignage : "La réforme des retraites est injuste. Ceux qui ont des métiers pénibles ne pourront jamais tenir jusqu'à 64 ans."
Réponse : ["Retraites", "Justice sociale et inégalités", "Emploi et conditions de travail"]`;

// Claude answers a testimony in a few seconds. A call that never answered
// held the admin's sequential "analyser tout" loop until undici gave up (300 s).
const ANALYSIS_TIMEOUT_MS = 60_000;
/** The heaviest answer read: a list of the 16 themes and its envelope weigh about 1 kB. */
const ANALYSIS_ANSWER_MAX_BYTES = 64 * 1024;

const anthropicFetch = upstreamFetch(ANALYSIS_ANSWER_MAX_BYTES);

/**
 * The themes of the grid a model answer names, in the grid's order: the JSON
 * list it holds (from its first "[" to its last "]"), read item by item
 * (anything that is not a theme's name is left out), or, when it holds no
 * such list, the grid's names its text spells.
 */
export function themesOfAnswer(text: string): string[] {
  let listed: unknown = null;
  try {
    const from = text.indexOf("[");
    const to = text.lastIndexOf("]");
    listed = JSON.parse(from >= 0 && to > from ? text.slice(from, to + 1) : "null");
  } catch {
    // Not a list: the names its text spells.
    const lower = text.toLowerCase();
    return AUDITION_THEMES.filter((theme) => lower.includes(theme.toLowerCase()));
  }
  return Array.isArray(listed) ? [...themesOf(listed as string[])] : [];
}

/** The text of a Messages API answer; null when the body is not one. */
function answerText(body: unknown): string | null {
  const content = (body as { content?: unknown } | null)?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | null)?.text : null;
  return typeof text === "string" ? text : null;
}

/** An answer too heavy to read, or that is not a Messages API answer. */
const unreadable = () =>
  new AnalysisError("L'API Anthropic a renvoyé une réponse illisible, réessayez.", 502);

/** Analyze a testimony's content; returns the identified theme names. */
export async function analyzeContent(content: string): Promise<string[]> {
  if (!config.ANTHROPIC_API_KEY) throw new AnalysisDisabledError();

  // The call and the reading of its answer, under one limit of time and size.
  let aiResponse: Response;
  try {
    aiResponse = await anthropicFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Voici le témoignage d'un(e) citoyen(ne). Identifie tous les thèmes abordés :\n\n${content}`,
          },
        ],
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof AnswerTooLargeError) throw unreadable();
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new AnalysisError(
      timedOut
        ? "L'API Anthropic n'a pas répondu dans le délai imparti (60 s), réessayez."
        : "L'API Anthropic est injoignable pour le moment, réessayez plus tard.",
      timedOut ? 504 : 502,
    );
  }

  if (!aiResponse.ok) {
    if (aiResponse.status === 429) {
      throw new AnalysisError("Limite de taux dépassée, réessayez plus tard.", 429);
    }
    if (aiResponse.status === 401) {
      throw new AnalysisError("Clé API Anthropic invalide. Vérifiez ANTHROPIC_API_KEY.", 401);
    }
    throw new AnalysisError(`Erreur API Anthropic: ${aiResponse.status}`, 502);
  }

  const text = answerText(await aiResponse.json().catch(() => null));
  if (text === null) throw unreadable();
  return themesOfAnswer(text);
}
