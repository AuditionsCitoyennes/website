<script setup lang="ts">
import { PRIVACY_EMAIL, PUBLISHER, mailto } from "@/shared/contact";
import { ROUTE } from "@/shared/routes";
import LegalLayout from "../LegalLayout.vue";
import { RECIPIENTS, RETENTION, TRACKERS } from "../content";

const privacyMail = mailto(PRIVACY_EMAIL, "Mes données personnelles");
</script>

<template>
  <LegalLayout
    title="Confidentialité"
    lead="Ce que le site collecte, pourquoi, combien de temps, et comment exercer vos droits."
  >
    <section>
      <h2>Qui est responsable</h2>
      <p>
        Le responsable du traitement est <strong>{{ PUBLISHER }}</strong
        >, qui porte le projet en attendant la création de son association (voir les
        <RouterLink :to="ROUTE.legalNotice.path">mentions légales</RouterLink>). Pour toute question
        sur vos données&nbsp;: <a :href="privacyMail">{{ PRIVACY_EMAIL }}</a
        >.
      </p>
    </section>

    <section>
      <h2>Ce que nous collectons, et pourquoi</h2>

      <h3>Si vous témoignez en ligne</h3>
      <ul>
        <li>
          <strong>Votre commune</strong> (obligatoire), <strong>un nom ou un pseudonyme</strong> et
          <strong>quelques mots sur vous</strong> (facultatifs&nbsp;: sans nom, le témoignage est
          signé « Anonyme »), et <strong>vos réponses</strong>&nbsp;: pour les publier.
        </li>
        <li>
          <strong>Votre email</strong>&nbsp;: pour vous envoyer le lien qui valide, modifie ou
          supprime votre témoignage. Il n'est jamais publié et n'est pas gardé&nbsp;: seule une
          empreinte chiffrée sert, huit jours, à limiter l'envoi à un témoignage par semaine.
        </li>
      </ul>
      <p>Base légale&nbsp;: votre consentement, donné en cochant la case du formulaire.</p>

      <h3>Si vous témoignez lors d'une audition publique</h3>
      <p>
        Un volontaire note votre nom ou pseudonyme, quelques mots sur vous si vous le souhaitez, et
        vos réponses. C'est à lui que vous donnez votre accord pour que votre témoignage soit
        publié&nbsp;; en l'ajoutant au site, il certifie que vous l'avez donné, et nous gardons qui
        l'a certifié et quand. Si vous lui laissez votre email, vous recevez un lien pour relire,
        modifier, valider ou supprimer votre témoignage. Base légale&nbsp;: votre consentement.
      </p>

      <h3>Si vous créez un compte de volontaire</h3>
      <p>
        Votre email, votre mot de passe (chiffré, illisible même pour nous), un nom d'utilisateur
        et, si vous le souhaitez, quelques mots sur vous&nbsp;: pour vous connecter et pour que les
        administrateurs examinent votre demande. Avec la connexion « avec Google », nous recevons le
        nom et l'email de votre compte Google. Base légale&nbsp;: les
        <RouterLink :to="ROUTE.rules.path">règles de publication</RouterLink>, que vous acceptez en
        créant le compte.
      </p>

      <h3>Quand vous visitez le site</h3>
      <p>
        Votre adresse IP sert à limiter les abus (envois en masse, robots). Le site la garde en
        mémoire au plus 24 heures et ne l'enregistre pas dans sa base. Base légale&nbsp;: notre
        intérêt légitime à protéger le site. Il n'y a ni publicité, ni mesure d'audience, ni bouton
        de réseau social.
      </p>
    </section>

    <section>
      <h2>Vos opinions sont des données sensibles</h2>
      <p>
        Vos réponses peuvent révéler vos opinions politiques, vos convictions ou votre santé. La loi
        les protège particulièrement&nbsp;: nous ne les publions qu'avec votre
        <strong>accord exprès</strong>, donné en cochant la case du formulaire, ou auprès du
        volontaire lors d'une audition. Vous pouvez retirer cet accord à tout moment&nbsp;: votre
        témoignage est alors supprimé.
      </p>
      <p>
        Pour faire ressortir les grands thèmes d'un territoire, un administrateur peut faire classer
        un témoignage par thèmes («&nbsp;Santé&nbsp;», «&nbsp;Logement&nbsp;»…) par un modèle
        d'intelligence artificielle, Claude, d'Anthropic. Seul le texte lui est envoyé, sans nom ni
        email.
      </p>
    </section>

    <section>
      <h2>Ce qui est public</h2>
      <p>
        Un témoignage publié montre le nom ou pseudonyme choisi, les quelques mots sur vous, la
        commune ou le lieu de l'audition, sa date, vos réponses et leurs thèmes. Il est visible de
        tous, aussi sous forme de données téléchargeables, et peut être repris par des moteurs de
        recherche ou par d'autres sites.
      </p>
      <p class="legal-box">
        Retirer un témoignage du site ne l'efface pas des copies faites ailleurs. Si vous ne voulez
        pas être reconnu, témoignez sous un pseudonyme ou en « Anonyme », et ne donnez pas de
        détails qui vous désignent.
      </p>
    </section>

    <section>
      <h2>Combien de temps</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Donnée</th>
            <th scope="col">Durée</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in RETENTION" :key="r.what">
            <td>{{ r.what }}</td>
            <td data-label="Durée">{{ r.how }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>Qui y a accès</h2>
      <p>
        Les administrateurs du site, et les prestataires qui le font fonctionner, chacun pour sa
        part et selon nos instructions. Aucune donnée n'est vendue ni cédée.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Prestataire</th>
            <th scope="col">Pour</th>
            <th scope="col">Données</th>
            <th scope="col">Où</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in RECIPIENTS" :key="r.name">
            <td>{{ r.name }}</td>
            <td data-label="Pour">{{ r.purpose }}</td>
            <td data-label="Données">{{ r.data }}</td>
            <td data-label="Où">{{ r.where }}</td>
          </tr>
        </tbody>
      </table>
      <p>
        Plusieurs de ces prestataires sont des entreprises américaines. Ces transferts hors de
        l'Union européenne sont encadrés, selon le prestataire, par le cadre de protection des
        données UE–États-Unis (Data Privacy Framework) ou par les clauses contractuelles types de la
        Commission européenne.
      </p>
    </section>

    <section>
      <h2>Traceurs</h2>
      <p>
        Le site ne dépose aucun cookie. Il garde dans votre navigateur seulement ce dont il a besoin
        pour fonctionner&nbsp;; aucun de ces éléments ne sert à la publicité ni à vous suivre d'un
        site à l'autre, c'est pourquoi il n'y a pas de bandeau de consentement.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Nom</th>
            <th scope="col">Type</th>
            <th scope="col">À quoi il sert</th>
            <th scope="col">Durée</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in TRACKERS" :key="t.name">
            <td>{{ t.name }}</td>
            <td data-label="Type">{{ t.kind }}</td>
            <td data-label="À quoi il sert">{{ t.purpose }}</td>
            <td data-label="Durée">{{ t.until }}</td>
          </tr>
        </tbody>
      </table>
      <p>Vous pouvez les effacer à tout moment dans les réglages de votre navigateur.</p>
    </section>

    <section>
      <h2>Vos droits</h2>
      <p>
        Vous pouvez accéder à vos données, les corriger, les faire effacer, en obtenir une copie,
        vous opposer à leur traitement ou en demander la limitation, et retirer votre consentement à
        tout moment.
      </p>
      <ul>
        <li>
          <strong>Votre témoignage</strong>&nbsp;: le lien reçu par email permet de le modifier ou
          de le supprimer pendant 14 jours. Ensuite, ou sans email, écrivez à
          <a :href="privacyMail">{{ PRIVACY_EMAIL }}</a> en indiquant le témoignage concerné.
        </li>
        <li>
          <strong>Votre compte</strong>&nbsp;: supprimez-le vous-même depuis l'espace admin, ou
          écrivez-nous.
        </li>
        <li>
          <strong>Vous êtes cité dans un témoignage</strong>&nbsp;: écrivez-nous, ou utilisez le
          lien « Signaler » sous le témoignage.
        </li>
      </ul>
      <p>
        Nous répondons dans un délai d'un mois. Si vous estimez que vos droits ne sont pas
        respectés, vous pouvez saisir la CNIL&nbsp;:
        <a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noopener">cnil.fr/plaintes</a
        >.
      </p>
    </section>

    <section>
      <h2>Mineurs</h2>
      <p>
        Il faut avoir 15 ans ou plus pour témoigner seul. Avant 15 ans, un parent doit donner son
        accord et remplir le formulaire avec vous.
      </p>
    </section>

    <section>
      <h2>Sécurité</h2>
      <p>
        Les échanges avec le site sont chiffrés (HTTPS), les mots de passe sont chiffrés, les emails
        des témoins en ligne ne sont pas gardés, et les sauvegardes sont chiffrées avant de quitter
        la base. Seuls les administrateurs accèdent aux données non publiques.
      </p>
    </section>

    <section>
      <h2>Modifications</h2>
      <p>
        Cette page peut évoluer, notamment à la création de l'association. La date de mise à jour
        figure en haut de la page.
      </p>
    </section>
  </LegalLayout>
</template>
