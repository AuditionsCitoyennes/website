# Contributing to Auditions Citoyennes

Merci de vouloir contribuer ! 🙌 Ce document explique comment proposer des changements proprement.

## Sommaire
- [Code de conduite](#code-de-conduite)
- [Mettre en place le projet](#mettre-en-place-le-projet)
- [Workflow de contribution](#workflow-de-contribution)
- [Nommage des branches](#nommage-des-branches)
- [Sign-off (DCO)](#sign-off-dco)
- [Pull requests](#pull-requests)
- [Sécurité](#sécurité)

## Code de conduite
Ce projet adhère au [Code de conduite](CODE_OF_CONDUCT.md). En participant, vous vous engagez à le respecter.

## Mettre en place le projet

Prérequis : **Node.js 20+** et **npm**.

```sh
git clone https://github.com/AuditionsCitoyennes/website.git
cd website
npm install
cp apps/api/.env.example apps/api/.env   # remplir les variables
cp apps/web/.env.example apps/web/.env
npm run dev
```

Avant de pousser, vérifiez localement :

```sh
npm run typecheck
npm run build
```

## Workflow de contribution

1. **Forkez** le dépôt (ou créez une branche si vous êtes membre).
2. Créez une branche depuis **`dev`** (voir [nommage](#nommage-des-branches)).
3. Faites vos changements, avec des commits **signés** (`git commit -s`).
4. Ouvrez une **pull request vers `dev`** (jamais directement vers `main`).
5. La CI (typecheck, build) et le contrôle DCO doivent passer ; un·e mainteneur·euse relit puis merge en **squash**.

> `main` = production, `dev` = intégration. Toute PR cible `dev`.

## Nommage des branches

| Préfixe | Usage |
|---|---|
| `feat/…` | nouvelle fonctionnalité |
| `fix/…` | correction de bug |
| `docs/…` | documentation |
| `chore/…` | maintenance, outillage |
| `refactor/…` | refactorisation sans changement de comportement |

Exemple : `feat/carte-filtre-themes`.

## Sign-off (DCO)

Ce projet utilise le **[Developer Certificate of Origin](https://developercertificate.org/)**. Chaque commit doit être **signé**, ce qui certifie que vous avez le droit de soumettre ce code sous la licence du projet (AGPL-3.0).

Ajoutez simplement l'option `-s` à vos commits :

```sh
git commit -s -m "feat: …"
```

Cela ajoute une ligne à votre message de commit :

```
Signed-off-by: Votre Nom <votre.email@example.com>
```

(utilisez un vrai nom et l'email associé à votre compte GitHub.)

Vous avez oublié sur des commits déjà faits ? Rattrapez-les :

```sh
git rebase --signoff dev
```

Les commits faits via l'interface web de GitHub sont signés automatiquement (réglage activé sur le dépôt).

## Pull requests

- Une PR = un sujet cohérent. Les petites PR sont relues plus vite.
- Remplissez le modèle de PR.
- Gardez la PR à jour avec `dev` si besoin.
- L'historique est **squashé** au merge : pas besoin de nettoyer chaque commit, mais un titre de PR clair est apprécié (il devient le message de commit).

## Sécurité

Ne signalez **jamais** une faille de sécurité via une issue publique. Suivez la procédure de [SECURITY.md](SECURITY.md).

Le projet traite des **données personnelles de citoyens** : soyez particulièrement vigilant·e avec les logs, les messages d'erreur et les colonnes exposées par l'API.
