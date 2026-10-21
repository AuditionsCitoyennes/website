# france-geojson (contours de la métropole, des régions et des départements)

Les trois fichiers de ce dossier sont les niveaux statiques que l'API sert sur
`/api/boundaries/{metropole,regions,departements}` (`modules/boundaries/service.ts`).
Ils sont embarqués dans le dépôt pour qu'un démarrage à froid ne contacte jamais
GitHub : avant, ils étaient téléchargés depuis `raw.githubusercontent.com` à la
première demande, puis gardés dans le cache disque.

- `metropole-version-simplifiee.geojson` — contour de la France métropolitaine
  (une seule Feature, sans propriétés ; l'API la nomme `FR` / `France`).
- `regions-version-simplifiee.geojson` — les 13 régions métropolitaines.
- `departements-version-simplifiee.geojson` — les 96 départements métropolitains.

## Source et attribution

- Dépôt : [gregoiredavid/france-geojson](https://github.com/gregoiredavid/france-geojson)
  (Grégoire David), branche `master`, fichiers récupérés le 2026-10-21.
- Tracés : IGN, [Admin Express COG](https://geoservices.ign.fr/adminexpress), édition 2018,
  convertis en GeoJSON avec Mapshaper (simplification « visvalingam weighted » à 25 %,
  coordonnées à 5 décimales), tels que publiés par le dépôt ci-dessus.
- Noms et codes : INSEE, Code Officiel Géographique, millésime 2018.
- Licence : [Licence Ouverte / Open Licence (Etalab)](https://www.etalab.gouv.fr/licence-ouverte-open-licence),
  conditions d'utilisation d'Admin Express. Mention à conserver :
  « Source : IGN — Admin Express COG 2018, via france-geojson (Grégoire David) — Licence Ouverte ».

Sommes de contrôle (md5) des fichiers tels que récupérés :

| Fichier | md5 |
| --- | --- |
| `metropole-version-simplifiee.geojson` | `5b50944d1ca5e003c3275e6e76d5615f` |
| `regions-version-simplifiee.geojson` | `275e39e649b090b9a8dd957659f8d611` |
| `departements-version-simplifiee.geojson` | `7999bd8fa3567d938032da52f6a9bfdf` |

Pour les mettre à jour : remplacer les fichiers, mettre à jour la date et les
sommes ci-dessus, et supprimer les trois clés `metropole`, `regions` et
`departements` du cache disque (`apps/api/.boundaries-cache/`), qui gardent
sinon l'ancienne version.
