-- Migration 047: Dynamic chat credit pricing
-- Replaces hardcoded CHAT_CREDITS=3 with dynamic calculation based on actual LLM cost
-- Date: 2026-02-18

-- Update calculate_credits_for_tool to include ai_chat with budget-aware pricing
CREATE OR REPLACE FUNCTION calculate_credits_for_tool(
  p_tool_name VARCHAR,
  p_user_id UUID
)
RETURNS INTEGER AS $$
DECLARE
  v_credits INTEGER;
BEGIN
  CASE
    WHEN p_tool_name IN ('search_court_cases', 'semantic_search', 'search_legal_precedents') THEN
      v_credits := 1;
    WHEN p_tool_name IN ('get_document_text', 'get_legislation_section') THEN
      v_credits := 1;
    WHEN p_tool_name IN ('packaged_lawyer_answer', 'get_legal_advice') THEN
      v_credits := 3;
    WHEN p_tool_name IN ('find_legal_patterns', 'find_similar_fact_pattern_cases') THEN
      v_credits := 2;
    WHEN p_tool_name IN ('search_legislation', 'search_supreme_court_practice') THEN
      v_credits := 1;
    WHEN p_tool_name = 'ai_chat' THEN
      v_credits := 1; -- Minimum pre-flight check; actual cost calculated post-execution
    ELSE
      v_credits := 1;
  END CASE;

  RETURN v_credits;
END;
$$ LANGUAGE plpgsql;

-- New function: Convert USD cost to credits
-- Rate: 1 credit = $0.01 USD, minimum 1 credit
CREATE OR REPLACE FUNCTION usd_to_credits(
  p_cost_usd DECIMAL
)
RETURNS INTEGER AS $$
BEGIN
  RETURN GREATEST(1, CEIL(p_cost_usd / 0.01));
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION usd_to_credits IS 'Convert USD cost to credits (1 credit = $0.01, minimum 1)';
