-- Migration 281: search_case_status_by_party names private persons in its `party` argument.
-- cost_tracking keeps calls indefinitely, so the party is stored as a hash from now on
-- (services/cost-tracker.ts redactPersonalParams); this replaces the names already stored.
-- Same hash as the code: 'sha256:' + first 12 hex of sha256(lower(trim(party))).
UPDATE cost_tracking
   SET query_params = jsonb_set(query_params::jsonb, '{party}',
         to_jsonb('sha256:' || left(encode(sha256(convert_to(lower(btrim(query_params->>'party')), 'UTF8')), 'hex'), 12))),
       user_query = (jsonb_set(query_params::jsonb, '{party}',
         to_jsonb('sha256:' || left(encode(sha256(convert_to(lower(btrim(query_params->>'party')), 'UTF8')), 'hex'), 12))))::text
 WHERE tool_name = 'search_case_status_by_party'
   AND query_params->>'party' IS NOT NULL
   AND query_params->>'party' NOT LIKE 'sha256:%';
