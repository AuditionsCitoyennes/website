// The three questions of an audition — asked face to face, and by the site's
// "Témoigner" form, which takes one answer to each.
//
// The answers are stored as ONE testimony text: each answered question on its
// own line, its answer under it, a blank line before the next. Everything that
// reads testimonies (search, analysis, the old app) reads them as they are;
// the pages that know the format show them as questions and answers.

export const AUDITION_QUESTIONS = [
  "Comment allez-vous ?",
  "Selon vous, comment va la France ?",
  "Si vous pouviez changer les choses, que feriez-vous ?",
] as const;

/** Longest answer to one question (three of them stay within the 5,000
 *  characters of an online testimony). */
export const ONLINE_ANSWER_MAX = 1500;

export interface Answer {
  question: string;
  answer: string;
}

/** A line as compared with the questions: spaces (non-breaking ones too)
 *  evened out, and the French space before "?" whether it was typed or not. */
function normalize(line: string): string {
  return line.replace(/\s+/g, " ").trim().replace(/ ?\?$/, " ?");
}

/** The questions as a line is compared with them (see `normalize`), in order:
 *  the database's search_text is computed from the same list. */
export const NORMALIZED_QUESTIONS: readonly string[] = AUDITION_QUESTIONS.map(normalize);

/** Each question's position, by its normalized line. */
const QUESTION_AT = new Map<string, number>(NORMALIZED_QUESTIONS.map((q, i) => [q, i]));

/** An answer whose own line is one of the questions (a witness quoting it):
 *  that line goes in quotation marks, so it can never be read as the start of
 *  the next answer. */
function quoteQuestionLines(answer: string): string {
  return answer
    .split("\n")
    .map((line) => (QUESTION_AT.has(normalize(line)) ? `« ${line.trim()} »` : line))
    .join("\n");
}

/** One testimony text from the form's answers (one per question, in order);
 *  a question left unanswered is left out. */
export function composeAnswers(answers: readonly string[]): string {
  return AUDITION_QUESTIONS.map((question, i) => ({
    question,
    answer: quoteQuestionLines((answers[i] ?? "").replace(/\r\n?/g, "\n").trim()),
  }))
    .filter((a) => a.answer)
    .map((a) => `${a.question}\n${a.answer}`)
    .join("\n\n");
}

/**
 * The answers back out of a text written by composeAnswers — or null for any
 * other text: a testimony noted at an audition, or one whose questions were
 * edited away. Text before the first question means it is not one.
 *
 * composeAnswers writes each question once, in order: a question line is one
 * only if it comes after the previous one. Any other — a witness quoting a
 * question inside an answer — is part of that answer.
 */
export function parseAnswers(content: string): Answer[] | null {
  const out: Answer[] = [];
  let current: { question: string; at: number; lines: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const answer = current.lines.join("\n").trim();
    if (answer) out.push({ question: current.question, answer });
  };
  for (const line of content.split(/\r?\n/)) {
    const at = QUESTION_AT.get(normalize(line));
    if (at !== undefined && at > (current?.at ?? -1)) {
      close();
      current = { question: AUDITION_QUESTIONS[at], at, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      return null;
    }
  }
  close();
  return out.length > 0 ? out : null;
}

/** The witness's own words only: a composed text without its questions
 *  (every question contains "vous", one "France" — a search must not match
 *  every online testimony on them). Any other text as it is. */
export function answersText(content: string): string {
  const answers = parseAnswers(content);
  return answers ? answers.map((a) => a.answer).join("\n\n") : content;
}
