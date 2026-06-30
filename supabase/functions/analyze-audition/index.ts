import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { auditionId, content } = await req.json();

    if (!auditionId || !content) {
      throw new Error("auditionId et content sont requis");
    }

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY n'est pas configuré. Ajoutez votre clé API Anthropic dans les secrets Supabase.");
    }

    console.log(`Analyse de l'audition ${auditionId}...`);

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Voici le témoignage d'un(e) citoyen(ne). Identifie tous les thèmes abordés :\n\n${content}`
          }
        ],
        temperature: 0.1,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('Erreur API Anthropic:', aiResponse.status, errorText);

      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de taux dépassée, réessayez plus tard." }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (aiResponse.status === 401) {
        return new Response(JSON.stringify({ error: "Clé API Anthropic invalide. Vérifiez ANTHROPIC_API_KEY." }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Erreur API Anthropic: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const analysisText = aiData.content[0].text;

    console.log('Réponse Claude:', analysisText);

    let topics: string[] = [];
    try {
      const jsonMatch = analysisText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        topics = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('Erreur de parsing JSON:', e);
      const themesList = [
        "Santé et accès aux soins", "Éducation", "Emploi et conditions de travail",
        "Logement", "Pouvoir d'achat et inflation", "Retraites",
        "Justice sociale et inégalités", "Démocratie et institutions",
        "Médias et information", "Sécurité et police", "Immigration",
        "Environnement et écologie", "Guerre et géopolitique",
        "Services publics", "Fiscalité", "Culture et loisirs"
      ];

      topics = themesList.filter(theme =>
        analysisText.toLowerCase().includes(theme.toLowerCase())
      );
    }

    console.log('Thèmes extraits:', topics);

    return new Response(JSON.stringify({ topics }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Erreur dans analyze-audition:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Erreur inconnue' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
