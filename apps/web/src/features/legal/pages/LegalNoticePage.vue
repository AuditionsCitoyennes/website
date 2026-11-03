<script setup lang="ts">
import { CONTACT_EMAIL, PUBLISHER, SOURCE_URL, mailto } from "@/shared/contact";
import { ROUTE } from "@/shared/routes";
import LegalLayout from "../LegalLayout.vue";
import { HOSTS } from "../content";
</script>

<template>
  <LegalLayout title="Mentions légales">
    <section>
      <h2>Éditeur</h2>
      <p>
        Auditions Citoyennes est un projet citoyen et bénévole. Il n'a pas encore
        d'association&nbsp;: en attendant qu'elle soit créée, le site est édité à titre non
        professionnel par
        <strong>{{ PUBLISHER }}</strong
        >, qui porte le projet.
      </p>
      <p>
        Comme le permet l'article 1-1 II de la loi pour la confiance dans l'économie numérique,
        l'éditeur a communiqué ses coordonnées complètes aux hébergeurs ci-dessous.
      </p>
      <p>
        Contact&nbsp;:
        <a :href="mailto(CONTACT_EMAIL, 'Auditions Citoyennes')">{{ CONTACT_EMAIL }}</a>
      </p>
    </section>

    <section>
      <h2>Directeur de la publication</h2>
      <p>{{ PUBLISHER }}.</p>
    </section>

    <section>
      <h2>Hébergement</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Hébergeur</th>
            <th scope="col">Ce qu'il héberge</th>
            <th scope="col">Adresse</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in HOSTS" :key="h.name">
            <td>{{ h.name }}</td>
            <td data-label="Héberge">{{ h.role }}</td>
            <td data-label="Adresse">{{ h.address }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>Témoignages</h2>
      <p>
        Les témoignages sont publiés sous la responsabilité de leurs auteurs, selon les
        <RouterLink :to="ROUTE.rules.path">règles de publication</RouterLink>. Pour signaler un
        témoignage, voir ces règles, ou écrire à
        <a :href="mailto(CONTACT_EMAIL, 'Signalement')">{{ CONTACT_EMAIL }}</a
        >.
      </p>
    </section>

    <section>
      <h2>Données personnelles</h2>
      <p>
        Ce que le site collecte, pourquoi, et vos droits&nbsp;: voir la
        <RouterLink :to="ROUTE.privacy.path">politique de confidentialité</RouterLink>.
      </p>
    </section>

    <section>
      <h2>Propriété intellectuelle et crédits</h2>
      <ul>
        <li>
          Le code du site est un logiciel libre, sous licence AGPL-3.0&nbsp;:
          <a :href="SOURCE_URL" target="_blank" rel="noopener">son code source</a>.
        </li>
        <li>Chaque témoignage reste la propriété de son auteur.</li>
        <li>
          Les photos de la page d'accueil viennent d'Unsplash et de Pexels, sous leurs licences
          libres&nbsp;; leurs auteurs sont crédités sous chaque photo.
        </li>
        <li>
          Carte © Mapbox © OpenStreetMap&nbsp;; les sources des contours sont créditées sur la
          carte.
        </li>
        <li>Polices Bebas Neue et Source Sans 3, sous licence SIL Open Font License.</li>
      </ul>
    </section>
  </LegalLayout>
</template>
