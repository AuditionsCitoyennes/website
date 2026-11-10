<script setup lang="ts">
import { CONTACT_EMAIL, PRIVACY_EMAIL, mailto } from "@/shared/contact";
import { ROUTE } from "@/shared/routes";
import LegalLayout from "../LegalLayout.vue";

const reportMail = mailto(CONTACT_EMAIL, "Signalement d'un témoignage");
// `!!`: a constant the template reads as is, so a build without the analyses
// (vite.config's __ANALYSES__) drops their clause.
const analysesOn = !!__ANALYSES__;
</script>

<template>
  <LegalLayout
    title="Règles de publication"
    lead="Ce que l'on peut publier sur Auditions Citoyennes, comment les témoignages sont relus, et comment en signaler un."
  >
    <section>
      <h2>Ce que vous pouvez publier</h2>
      <p>
        Ce que vous vivez et ce que vous pensez&nbsp;: votre quotidien, votre avis sur le pays, ce
        que vous changeriez. Toutes les opinions ont leur place, exprimées sans s'en prendre à
        personne.
      </p>
    </section>

    <section>
      <h2>Ce qui n'est pas publié</h2>
      <ul>
        <li>les insultes, les menaces, les appels à la violence&nbsp;;</li>
        <li>
          les propos haineux ou discriminatoires (origine, religion, sexe, orientation sexuelle,
          handicap…)&nbsp;;
        </li>
        <li>
          des informations sur d'autres personnes&nbsp;: le nom d'un particulier, son adresse, sa
          santé, sa vie privée. Parler d'un élu ou d'une institution dans son rôle public reste
          possible.
        </li>
      </ul>
      <p>Un témoignage qui enfreint ces règles est retiré, en tout ou en partie.</p>
    </section>

    <section>
      <h2>Comment les témoignages sont publiés</h2>
      <ul>
        <li>
          <strong>En ligne</strong>&nbsp;: le témoignage est publié une fois validé par le lien reçu
          par email. Son auteur peut le modifier ou le supprimer avec ce même lien.
        </li>
        <li>
          <strong>Lors d'une audition publique</strong>&nbsp;: un volontaire note les réponses, avec
          l'accord de la personne, et les publie avec l'audition.
        </li>
        <li>
          Les témoignages sont publiés tels quels. Les administrateurs peuvent les relire, les
          classer par thèmes, et retirer ce qui ne respecte pas ces règles.
        </li>
      </ul>
    </section>

    <section>
      <h2>Vos droits sur votre témoignage</h2>
      <p>
        Vous restez l'auteur de votre témoignage. En le publiant, vous autorisez Auditions
        Citoyennes, gratuitement et tant qu'il est en ligne, à l'afficher sur le site et sur la
        carte, à le classer par thèmes<template v-if="analysesOn"
          >, à le compter dans les analyses d'un territoire</template
        >
        et à le diffuser avec les données publiques du site. Vous pouvez le retirer à tout moment
        (voir la <RouterLink :to="ROUTE.privacy.path">politique de confidentialité</RouterLink>).
      </p>
    </section>

    <section>
      <h2>Signaler un témoignage</h2>
      <p>
        Sous chaque témoignage, le lien <strong>« Signaler »</strong> prépare un email avec la
        référence du témoignage&nbsp;: dites-nous ce qui pose problème. Vous pouvez aussi écrire à
        <a :href="reportMail">{{ CONTACT_EMAIL }}</a> en indiquant la page et le témoignage.
      </p>
      <p>
        Chaque signalement est examiné rapidement. Ce qui est manifestement illicite est retiré sans
        attendre&nbsp;; pour le reste, nous décidons au vu de ces règles et répondons à la personne
        qui a signalé. Si un témoignage vous concerne personnellement, vous pouvez aussi demander
        son retrait à
        <a :href="mailto(PRIVACY_EMAIL, 'Témoignage me concernant')">{{ PRIVACY_EMAIL }}</a
        >.
      </p>
    </section>

    <section>
      <h2>Pour les volontaires</h2>
      <p>En créant un compte, vous acceptez ces règles, et en particulier&nbsp;:</p>
      <ul>
        <li>
          ne noter un témoignage qu'avec l'accord de la personne, après lui avoir dit qu'il sera
          public, sous le nom ou le pseudonyme qu'elle choisit, ou en « Anonyme »&nbsp;;
        </li>
        <li>
          lui dire qu'elle peut le faire retirer à tout moment, et comment&nbsp;: le lien reçu par
          email si elle en laisse un, sinon {{ PRIVACY_EMAIL }}&nbsp;;
        </li>
        <li>
          ne recueillir le témoignage d'un enfant de moins de 15 ans qu'avec l'accord d'un
          parent&nbsp;;
        </li>
        <li>retranscrire les réponses fidèlement, sans rien ajouter.</li>
      </ul>
    </section>
  </LegalLayout>
</template>
