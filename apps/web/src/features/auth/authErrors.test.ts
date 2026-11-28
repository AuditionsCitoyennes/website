// Supabase Auth's refusals in French (authErrors.ts), run with `node --import
// tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authCode,
  emailRequestError,
  mapAuthError,
  newPasswordError,
  secondFactorError,
} from "./authErrors";

/** An error as auth-js raises it. */
const refusal = (code: string, status = 400, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`English text for ${code}`), { code, status, ...extra });

test("the code of an Auth error, and none for anything else", () => {
  assert.equal(authCode(refusal("weak_password")), "weak_password");
  assert.equal(authCode(new Error("x")), null);
  assert.equal(authCode(null), null);
  assert.equal(authCode({ code: 42 }), null);
});

test("a refused sign-in never says which of the address and the password was wrong", () => {
  for (const code of [
    "invalid_credentials",
    "email_not_confirmed",
    "user_banned",
    "weak_password",
  ]) {
    assert.equal(mapAuthError(refusal(code), "login"), "Email ou mot de passe incorrect.");
  }
});

test("too many attempts, by code, by status or by text, in every context", () => {
  const limited = "Trop de tentatives, veuillez réessayer plus tard.";
  assert.equal(mapAuthError(refusal("over_request_rate_limit", 429), "login"), limited);
  assert.equal(mapAuthError(refusal("over_email_send_rate_limit"), "signup"), limited);
  assert.equal(mapAuthError(new Error("Email rate limit exceeded"), "signup"), limited);
  assert.equal(emailRequestError(refusal("unexpected_failure", 429)), limited);
  assert.equal(newPasswordError(refusal("over_request_rate_limit", 429)), limited);
  assert.equal(secondFactorError(refusal("over_request_rate_limit", 429)), limited);
});

test("a failed captcha is said as such", () => {
  const failed = "La vérification anti-robot a échoué, veuillez réessayer.";
  assert.equal(mapAuthError(refusal("captcha_failed"), "login"), failed);
  assert.equal(mapAuthError(refusal("captcha_failed"), "signup"), failed);
  assert.equal(emailRequestError(refusal("captcha_failed")), failed);
});

test("a password Auth finds too weak, by its reasons", () => {
  const weak = (reasons?: string[]) => refusal("weak_password", 422, { reasons });
  assert.match(mapAuthError(weak(["length"]), "signup"), /trop court/);
  assert.match(mapAuthError(weak(["characters"]), "signup"), /minuscules, majuscules et chiffres/);
  assert.match(newPasswordError(weak(["length", "pwned"])), /fuites de données/);
  assert.match(newPasswordError(weak()), /trop faible/);
  assert.doesNotMatch(newPasswordError(weak(["length"])), /English/);
});

test("a refused new password", () => {
  assert.match(newPasswordError(refusal("same_password", 422)), /différent de l'actuel/);
  assert.match(newPasswordError(refusal("insufficient_aal", 401)), /double authentification/);
  assert.match(newPasswordError(refusal("session_not_found", 403)), /lien a expiré/);
  assert.match(newPasswordError(new Error("network")), /n'a pas pu être modifié/);
});

test("a refused second-factor step", () => {
  assert.match(secondFactorError(refusal("mfa_verification_failed", 422)), /Code incorrect/);
  assert.match(secondFactorError(refusal("mfa_challenge_expired", 422)), /délai est dépassé/);
  assert.match(secondFactorError(refusal("mfa_totp_enroll_not_enabled", 422)), /pas disponible/);
  assert.match(secondFactorError(refusal("insufficient_aal", 401)), /confirmer cette action/);
  assert.equal(secondFactorError(new Error("x")), "Une erreur est survenue, veuillez réessayer.");
});
