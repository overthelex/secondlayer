import { XMLParser } from 'fast-xml-parser';

export interface ParsedUOEntity {
  record: string;
  edrpou?: string;
  name?: string;
  short_name?: string;
  opf?: string;
  stan?: string;
  authorized_capital?: string;
  founding_document_num?: string;
  purpose?: string;
  superior_management?: string;
  statute?: string;
  registration?: string;
  managing_paper?: string;
  terminated_info?: string;
  termination_cancel_info?: string;
  executive_power?: {
    name?: string;
    code?: string;
  };
  founders?: string[];
  beneficiaries?: string[];
  signers?: string[];
  members?: string[];
  branches?: Array<{
    code?: string;
    name?: string;
    signer?: string;
    create_date?: string;
  }>;
  predecessors?: Array<{
    name?: string;
    code?: string;
  }>;
  assignees?: Array<{
    name?: string;
    code?: string;
  }>;
  termination_started?: {
    op_date?: string;
    reason?: string;
    sbj_state?: string;
    signer_name?: string;
    creditor_req_end_date?: string;
  };
  bankruptcy_info?: {
    op_date?: string;
    reason?: string;
    sbj_state?: string;
    head_name?: string;
  };
  exchange_data?: Array<{
    tax_payer_type?: string;
    start_date?: string;
    start_num?: string;
    end_date?: string;
    end_num?: string;
  }>;
}

export interface ParsedFOPEntity {
  record: string;
  name?: string;
  stan?: string;
  farmer?: string;
  estate_manager?: string;
  registration?: string;
  terminated_info?: string;
  termination_cancel_info?: string;
  exchange_data?: Array<{
    tax_payer_type?: string;
    start_date?: string;
    start_num?: string;
    end_date?: string;
    end_num?: string;
  }>;
}

export interface ParsedFSUEntity {
  record: string;
  edrpou?: string;
  name?: string;
  short_name?: string;
  type_subject?: string;
  type_branch?: string;
  stan?: string;
  founding_document?: string;
  registration?: string;
  terminated_info?: string;
  termination_cancel_info?: string;
  founders?: string[];
  beneficiaries?: string[];
  signers?: string[];
  predecessors?: Array<{
    name?: string;
    code?: string;
  }>;
  termination_started?: {
    op_date?: string;
    reason?: string;
    sbj_state?: string;
    signer_name?: string;
    creditor_req_end_date?: string;
  };
  exchange_data?: Array<{
    tax_payer_type?: string;
    start_date?: string;
    start_num?: string;
    end_date?: string;
    end_num?: string;
  }>;
}

export class OpenReyestrXMLParser {
  private parser: XMLParser;

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: true,
      textNodeName: '#text',
      isArray: (tagName) => {
        return ['FOUNDER', 'BENEFICIARY', 'SIGNER', 'MEMBER', 'BRANCH',
                'PREDECESSOR', 'ASSIGNEE', 'EXCHANGE_ANSWER'].includes(tagName);
      },
    });
  }

  parseUO(xmlContent: string): ParsedUOEntity[] {
    const result = this.parser.parse(xmlContent);
    const subjects = Array.isArray(result.DATA.SUBJECT)
      ? result.DATA.SUBJECT
      : [result.DATA.SUBJECT];

    return subjects.map((subject: any) => this.extractUOData(subject));
  }

  parseFOP(xmlContent: string): ParsedFOPEntity[] {
    const result = this.parser.parse(xmlContent);
    const subjects = Array.isArray(result.DATA.SUBJECT)
      ? result.DATA.SUBJECT
      : [result.DATA.SUBJECT];

    return subjects.map((subject: any) => this.extractFOPData(subject));
  }

  parseFSU(xmlContent: string): ParsedFSUEntity[] {
    const result = this.parser.parse(xmlContent);
    const subjects = Array.isArray(result.DATA.SUBJECT)
      ? result.DATA.SUBJECT
      : [result.DATA.SUBJECT];

    return subjects.map((subject: any) => this.extractFSUData(subject));
  }

  private extractUOData(subject: any): ParsedUOEntity {
    const entity: ParsedUOEntity = {
      record: subject.RECORD || '',
      edrpou: subject.EDRPOU,
      name: subject.NAME,
      short_name: subject.SHORT_NAME,
      opf: subject.OPF,
      stan: subject.STAN,
      authorized_capital: subject.AUTHORIZED_CAPITAL,
      founding_document_num: subject.FOUNDING_DOCUMENT_NUM,
      purpose: subject.PURPOSE,
      superior_management: subject.SUPERIOR_MANAGEMENT,
      statute: subject.STATUTE,
      registration: subject.REGISTRATION,
      managing_paper: subject.MANAGING_PAPER,
      terminated_info: subject.TERMINATED_INFO,
      termination_cancel_info: subject.TERMINATION_CANCEL_INFO,
    };

    // Extract executive power
    if (subject.EXECUTIVE_POWER?.NAME || subject.EXECUTIVE_POWER?.CODE) {
      entity.executive_power = {
        name: subject.EXECUTIVE_POWER.NAME,
        code: subject.EXECUTIVE_POWER.CODE,
      };
    }

    // Extract founders
    if (subject.FOUNDERS?.FOUNDER) {
      entity.founders = Array.isArray(subject.FOUNDERS.FOUNDER)
        ? subject.FOUNDERS.FOUNDER
        : [subject.FOUNDERS.FOUNDER];
    }

    // Extract beneficiaries
    if (subject.BENEFICIARIES?.BENEFICIARY) {
      entity.beneficiaries = Array.isArray(subject.BENEFICIARIES.BENEFICIARY)
        ? subject.BENEFICIARIES.BENEFICIARY
        : [subject.BENEFICIARIES.BENEFICIARY];
    }

    // Extract signers
    if (subject.SIGNERS?.SIGNER) {
      entity.signers = Array.isArray(subject.SIGNERS.SIGNER)
        ? subject.SIGNERS.SIGNER
        : [subject.SIGNERS.SIGNER];
    }

    // Extract members
    if (subject.MEMBERS?.MEMBER) {
      entity.members = Array.isArray(subject.MEMBERS.MEMBER)
        ? subject.MEMBERS.MEMBER
        : [subject.MEMBERS.MEMBER];
    }

    // Extract branches
    if (subject.BRANCHES?.BRANCH) {
      const branches = Array.isArray(subject.BRANCHES.BRANCH)
        ? subject.BRANCHES.BRANCH
        : [subject.BRANCHES.BRANCH];
      entity.branches = branches.map((b: any) => ({
        code: b.CODE,
        name: b.NAME,
        signer: b.SIGNER,
        create_date: b.CREATE_DATE,
      }));
    }

    // Extract predecessors
    if (subject.PREDECESSORS?.PREDECESSOR) {
      const predecessors = Array.isArray(subject.PREDECESSORS.PREDECESSOR)
        ? subject.PREDECESSORS.PREDECESSOR
        : [subject.PREDECESSORS.PREDECESSOR];
      entity.predecessors = predecessors.map((p: any) => ({
        name: p.NAME,
        code: p.CODE,
      }));
    }

    // Extract assignees
    if (subject.ASSIGNEES?.ASSIGNEE) {
      const assignees = Array.isArray(subject.ASSIGNEES.ASSIGNEE)
        ? subject.ASSIGNEES.ASSIGNEE
        : [subject.ASSIGNEES.ASSIGNEE];
      entity.assignees = assignees.map((a: any) => ({
        name: a.NAME,
        code: a.CODE,
      }));
    }

    // Extract termination started info
    if (subject.TERMINATION_STARTED_INFO?.OP_DATE) {
      entity.termination_started = {
        op_date: subject.TERMINATION_STARTED_INFO.OP_DATE,
        reason: subject.TERMINATION_STARTED_INFO.REASON,
        sbj_state: subject.TERMINATION_STARTED_INFO.SBJ_STATE,
        signer_name: subject.TERMINATION_STARTED_INFO.SIGNER_NAME,
        creditor_req_end_date: subject.TERMINATION_STARTED_INFO.CREDITOR_REQ_END_DATE,
      };
    }

    // Extract bankruptcy info
    if (subject.BANKRUPTCY_READJUSTMENT_INFO?.OP_DATE) {
      entity.bankruptcy_info = {
        op_date: subject.BANKRUPTCY_READJUSTMENT_INFO.OP_DATE,
        reason: subject.BANKRUPTCY_READJUSTMENT_INFO.REASON,
        sbj_state: subject.BANKRUPTCY_READJUSTMENT_INFO.SBJ_STATE,
        head_name: subject.BANKRUPTCY_READJUSTMENT_INFO.BANKRUPTCY_READJUSTMENT_HEAD_NAME,
      };
    }

    // Extract exchange data
    if (subject.EXCHANGE_DATA?.EXCHANGE_ANSWER) {
      const answers = Array.isArray(subject.EXCHANGE_DATA.EXCHANGE_ANSWER)
        ? subject.EXCHANGE_DATA.EXCHANGE_ANSWER
        : [subject.EXCHANGE_DATA.EXCHANGE_ANSWER];
      entity.exchange_data = answers.map((a: any) => ({
        tax_payer_type: a.TAX_PAYER_TYPE,
        start_date: a.START_DATE,
        start_num: a.START_NUM,
        end_date: a.END_DATE,
        end_num: a.END_NUM,
      }));
    }

    return entity;
  }

  private extractFOPData(subject: any): ParsedFOPEntity {
    const entity: ParsedFOPEntity = {
      record: subject.RECORD || '',
      name: subject.NAME,
      stan: subject.STAN,
      farmer: subject.FARMER,
      estate_manager: subject.ESTATE_MANAGER,
      registration: subject.REGISTRATION,
      terminated_info: subject.TERMINATED_INFO,
      termination_cancel_info: subject.TERMINATION_CANCEL_INFO,
    };

    // Extract exchange data
    if (subject.EXCHANGE_DATA?.EXCHANGE_ANSWER) {
      const answers = Array.isArray(subject.EXCHANGE_DATA.EXCHANGE_ANSWER)
        ? subject.EXCHANGE_DATA.EXCHANGE_ANSWER
        : [subject.EXCHANGE_DATA.EXCHANGE_ANSWER];
      entity.exchange_data = answers.map((a: any) => ({
        tax_payer_type: a.TAX_PAYER_TYPE,
        start_date: a.START_DATE,
        start_num: a.START_NUM,
        end_date: a.END_DATE,
        end_num: a.END_NUM,
      }));
    }

    return entity;
  }

  private extractFSUData(subject: any): ParsedFSUEntity {
    const entity: ParsedFSUEntity = {
      record: subject.RECORD || '',
      edrpou: subject.EDRPOU,
      name: subject.NAME,
      short_name: subject.SHORT_NAME,
      type_subject: subject.TYPE_SUBJECT,
      type_branch: subject.TYPE_BRANCH,
      stan: subject.STAN,
      founding_document: subject.FOUNDING_DOCUMENT,
      registration: subject.REGISTRATION,
      terminated_info: subject.TERMINATED_INFO,
      termination_cancel_info: subject.TERMINATION_CANCEL_INFO,
    };

    // Extract founders
    if (subject.FOUNDERS?.FOUNDER) {
      entity.founders = Array.isArray(subject.FOUNDERS.FOUNDER)
        ? subject.FOUNDERS.FOUNDER
        : [subject.FOUNDERS.FOUNDER];
    }

    // Extract beneficiaries
    if (subject.BENEFICIARIES?.BENEFICIARY) {
      entity.beneficiaries = Array.isArray(subject.BENEFICIARIES.BENEFICIARY)
        ? subject.BENEFICIARIES.BENEFICIARY
        : [subject.BENEFICIARIES.BENEFICIARY];
    }

    // Extract signers
    if (subject.SIGNERS?.SIGNER) {
      entity.signers = Array.isArray(subject.SIGNERS.SIGNER)
        ? subject.SIGNERS.SIGNER
        : [subject.SIGNERS.SIGNER];
    }

    // Extract predecessors
    if (subject.PREDECESSORS?.PREDECESSOR) {
      const predecessors = Array.isArray(subject.PREDECESSORS.PREDECESSOR)
        ? subject.PREDECESSORS.PREDECESSOR
        : [subject.PREDECESSORS.PREDECESSOR];
      entity.predecessors = predecessors.map((p: any) => ({
        name: p.NAME,
        code: p.CODE,
      }));
    }

    // Extract termination started info
    if (subject.TERMINATION_STARTED_INFO?.OP_DATE) {
      entity.termination_started = {
        op_date: subject.TERMINATION_STARTED_INFO.OP_DATE,
        reason: subject.TERMINATION_STARTED_INFO.REASON,
        sbj_state: subject.TERMINATION_STARTED_INFO.SBJ_STATE,
        signer_name: subject.TERMINATION_STARTED_INFO.SIGNER_NAME,
        creditor_req_end_date: subject.TERMINATION_STARTED_INFO.CREDITOR_REQ_END_DATE,
      };
    }

    // Extract exchange data
    if (subject.EXCHANGE_DATA?.EXCHANGE_ANSWER) {
      const answers = Array.isArray(subject.EXCHANGE_DATA.EXCHANGE_ANSWER)
        ? subject.EXCHANGE_DATA.EXCHANGE_ANSWER
        : [subject.EXCHANGE_DATA.EXCHANGE_ANSWER];
      entity.exchange_data = answers.map((a: any) => ({
        tax_payer_type: a.TAX_PAYER_TYPE,
        start_date: a.START_DATE,
        start_num: a.START_NUM,
        end_date: a.END_DATE,
        end_num: a.END_NUM,
      }));
    }

    return entity;
  }
}
