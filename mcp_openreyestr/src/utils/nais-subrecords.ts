/**
 * The parser stores sub-records keyed by their XML tag (OP_DATE, REASON, ...), but the
 * importer reads op_date, reason, ... — so every termination_started / bankruptcy_info
 * row was written with NULL in all its columns (LEXAI-2198). Same mapping as the
 * non-streaming xml-parser.ts.
 */
export function mapTerminationStarted(info: Record<string, any>) {
  return {
    op_date: info.OP_DATE ?? info.op_date,
    reason: info.REASON ?? info.reason,
    sbj_state: info.SBJ_STATE ?? info.sbj_state,
    signer_name: info.SIGNER_NAME ?? info.signer_name,
    creditor_req_end_date: info.CREDITOR_REQ_END_DATE ?? info.creditor_req_end_date,
  };
}

export function mapBankruptcyInfo(info: Record<string, any>) {
  return {
    op_date: info.OP_DATE ?? info.op_date,
    reason: info.REASON ?? info.reason,
    sbj_state: info.SBJ_STATE ?? info.sbj_state,
    head_name: info.BANKRUPTCY_READJUSTMENT_HEAD_NAME ?? info.HEAD_NAME ?? info.head_name,
  };
}
