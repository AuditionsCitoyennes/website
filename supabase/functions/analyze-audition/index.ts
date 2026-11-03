// Switched off since 2026-11-03: topics are no longer suggested automatically.
// The old site's « Analyser » buttons show the message below. The earlier
// version is in the history of this file.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve((req: Request): Response => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({ error: "L'analyse automatique des témoignages est désactivée." }),
    { status: 410, headers: { "Content-Type": "application/json", ...corsHeaders } },
  );
});
