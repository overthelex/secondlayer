import sax from 'sax';
import { Readable } from 'stream';
import { ParsedUOEntity, ParsedFOPEntity, ParsedFSUEntity } from './xml-parser.js';

type EntityCallback<T> = (entity: T) => Promise<void>;
type BatchCallback<T> = (entities: T[]) => Promise<void>;

export class StreamingXMLParser {
  async parseUOStream(stream: Readable, onEntity: EntityCallback<ParsedUOEntity>): Promise<number> {
    return this.parseStream(stream, 'UO', onEntity);
  }

  async parseFOPStream(stream: Readable, onEntity: EntityCallback<ParsedFOPEntity>): Promise<number> {
    return this.parseStream(stream, 'FOP', onEntity);
  }

  async parseFSUStream(stream: Readable, onEntity: EntityCallback<ParsedFSUEntity>): Promise<number> {
    return this.parseStream(stream, 'FSU', onEntity);
  }

  /**
   * Parse with proper backpressure — pauses stream while batch is being processed.
   * Use this for large files (FOP 8GB+, UO 20GB+) to avoid OOM.
   */
  async parseBatched<T>(
    stream: Readable,
    entityType: 'UO' | 'FOP' | 'FSU',
    batchSize: number,
    onBatch: BatchCallback<T>
  ): Promise<number> {
    const parser = sax.createStream(true, { trim: true, normalize: true });
    let count = 0;
    let batch: T[] = [];
    let currentSubject: any = null;
    let currentPath: string[] = [];
    let currentValue = '';
    let currentArray: any[] | null = null;
    let currentArrayPath = '';
    let currentObject: any = null;
    let currentObjectPath = '';

    // We need manual flow control: pause the source when a batch is ready
    let resolveDrain: (() => void) | null = null;

    parser.on('opentag', (node) => {
      const tagName = node.name;
      currentPath.push(tagName);
      const path = currentPath.join('/');

      if (tagName === 'SUBJECT') {
        currentSubject = {};
        currentArray = null;
        currentArrayPath = '';
        currentObject = null;
        currentObjectPath = '';
      } else if (currentSubject) {
        if (['FOUNDER', 'BENEFICIARY', 'SIGNER', 'MEMBER', 'EXCHANGE_ANSWER'].includes(tagName)) {
          if (!currentArray) {
            currentArray = [];
            currentArrayPath = currentPath.slice(0, -1).join('/');
          }
          if (tagName === 'EXCHANGE_ANSWER') {
            currentObject = {};
            currentObjectPath = path;
          }
        } else if (['BRANCH', 'PREDECESSOR', 'ASSIGNEE'].includes(tagName)) {
          currentObject = {};
          currentObjectPath = path;
          if (!currentArray) {
            currentArray = [];
            currentArrayPath = currentPath.slice(0, -1).join('/');
          }
        }
      }
      currentValue = '';
    });

    parser.on('text', (text) => {
      if (text.trim()) {
        currentValue += text;
      }
    });

    parser.on('closetag', (tagName) => {
      if (tagName === 'SUBJECT' && currentSubject) {
        // Only push entities that have at minimum a name field
        if (currentSubject.NAME) {
          const entity = this.extractEntityData(currentSubject, entityType);
          batch.push(entity as T);
          count++;
        }
        currentSubject = null;
        // Reset array/object state to prevent leaks between entities
        currentArray = null;
        currentArrayPath = '';
        currentObject = null;
        currentObjectPath = '';
        if (count % 10000 === 0) {
          console.log(`  Parsed ${count} entities...`);
        }
      } else if (currentSubject) {
        const path = currentPath.join('/');

        if (currentObject && currentObjectPath === path) {
          currentArray!.push(currentObject);
          currentObject = null;
          currentObjectPath = '';
        }
        else if (currentArray && currentArrayPath === currentPath.slice(0, -1).join('/')) {
          if (!currentObject) {
            if (currentValue.trim()) {
              currentArray.push(currentValue.trim());
            }
          }

          if (tagName === 'FOUNDERS' && currentArray.length > 0) {
            currentSubject.FOUNDERS = { FOUNDER: currentArray };
          } else if (tagName === 'BENEFICIARIES' && currentArray.length > 0) {
            currentSubject.BENEFICIARIES = { BENEFICIARY: currentArray };
          } else if (tagName === 'SIGNERS' && currentArray.length > 0) {
            currentSubject.SIGNERS = { SIGNER: currentArray };
          } else if (tagName === 'MEMBERS' && currentArray.length > 0) {
            currentSubject.MEMBERS = { MEMBER: currentArray };
          } else if (tagName === 'BRANCHES' && currentArray.length > 0) {
            currentSubject.BRANCHES = { BRANCH: currentArray };
          } else if (tagName === 'PREDECESSORS' && currentArray.length > 0) {
            currentSubject.PREDECESSORS = { PREDECESSOR: currentArray };
          } else if (tagName === 'ASSIGNEES' && currentArray.length > 0) {
            currentSubject.ASSIGNEES = { ASSIGNEE: currentArray };
          } else if (tagName === 'EXCHANGE_DATA' && currentArray.length > 0) {
            currentSubject.EXCHANGE_DATA = { EXCHANGE_ANSWER: currentArray };
          }

          currentArray = null;
          currentArrayPath = '';
        }
        else if (currentValue.trim()) {
          const value = currentValue.trim();
          if (currentObject) {
            currentObject[tagName] = value;
          } else if (!currentArray) {
            if (path.includes('EXECUTIVE_POWER')) {
              if (!currentSubject.EXECUTIVE_POWER) currentSubject.EXECUTIVE_POWER = {};
              currentSubject.EXECUTIVE_POWER[tagName] = value;
            } else if (path.includes('TERMINATION_STARTED_INFO')) {
              if (!currentSubject.TERMINATION_STARTED_INFO) currentSubject.TERMINATION_STARTED_INFO = {};
              currentSubject.TERMINATION_STARTED_INFO[tagName] = value;
            } else if (path.includes('BANKRUPTCY_READJUSTMENT_INFO')) {
              if (!currentSubject.BANKRUPTCY_READJUSTMENT_INFO) currentSubject.BANKRUPTCY_READJUSTMENT_INFO = {};
              currentSubject.BANKRUPTCY_READJUSTMENT_INFO[tagName] = value;
            } else {
              currentSubject[tagName] = value;
            }
          }
        }
      }

      currentPath.pop();
      currentValue = '';
    });

    // Use a pull-based approach: read chunks manually with async iteration
    return new Promise<number>(async (resolve, reject) => {
      let finished = false;

      parser.on('error', (err) => {
        finished = true;
        reject(err);
      });

      parser.on('end', () => {
        finished = true;
      });

      // Pipe stream to parser but control flow via pause/resume
      stream.pipe(parser);

      // Poll for batches
      const checkBatch = async () => {
        while (!finished || batch.length > 0) {
          if (batch.length >= batchSize) {
            stream.pause();
            const toProcess = batch.splice(0, batchSize);
            try {
              await onBatch(toProcess);
            } catch (err) {
              console.error(`Batch insert error (continuing):`, err);
            }
            stream.resume();
          } else if (finished) {
            // Flush remaining
            if (batch.length > 0) {
              const toProcess = batch.splice(0, batch.length);
              try {
                await onBatch(toProcess);
              } catch (err) {
                console.error(`Final batch error:`, err);
              }
            }
            break;
          } else {
            // Wait a bit for more data
            await new Promise(r => setTimeout(r, 50));
          }
        }
        resolve(count);
      };

      checkBatch().catch(reject);
    });
  }

  // Keep old method for backward compat
  private async parseStream<T>(
    stream: Readable,
    entityType: 'UO' | 'FOP' | 'FSU',
    onEntity: EntityCallback<T>
  ): Promise<number> {
    return this.parseBatched<T>(stream, entityType, 1, async (entities) => {
      for (const entity of entities) {
        await onEntity(entity);
      }
    });
  }

  private extractEntityData(subject: any, entityType: 'UO' | 'FOP' | 'FSU'): ParsedUOEntity | ParsedFOPEntity | ParsedFSUEntity {
    if (entityType === 'UO') {
      return this.extractUOData(subject);
    } else if (entityType === 'FOP') {
      return this.extractFOPData(subject);
    } else {
      return this.extractFSUData(subject);
    }
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

    if (subject.EXECUTIVE_POWER) entity.executive_power = subject.EXECUTIVE_POWER;
    if (subject.FOUNDERS?.FOUNDER) entity.founders = subject.FOUNDERS.FOUNDER;
    if (subject.BENEFICIARIES?.BENEFICIARY) entity.beneficiaries = subject.BENEFICIARIES.BENEFICIARY;
    if (subject.SIGNERS?.SIGNER) entity.signers = subject.SIGNERS.SIGNER;
    if (subject.MEMBERS?.MEMBER) entity.members = subject.MEMBERS.MEMBER;
    if (subject.BRANCHES?.BRANCH) entity.branches = subject.BRANCHES.BRANCH;
    if (subject.PREDECESSORS?.PREDECESSOR) entity.predecessors = subject.PREDECESSORS.PREDECESSOR;
    if (subject.ASSIGNEES?.ASSIGNEE) entity.assignees = subject.ASSIGNEES.ASSIGNEE;
    if (subject.TERMINATION_STARTED_INFO) entity.termination_started = subject.TERMINATION_STARTED_INFO;
    if (subject.BANKRUPTCY_READJUSTMENT_INFO) entity.bankruptcy_info = subject.BANKRUPTCY_READJUSTMENT_INFO;
    if (subject.EXCHANGE_DATA?.EXCHANGE_ANSWER) entity.exchange_data = subject.EXCHANGE_DATA.EXCHANGE_ANSWER;

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

    if (subject.EXCHANGE_DATA?.EXCHANGE_ANSWER) entity.exchange_data = subject.EXCHANGE_DATA.EXCHANGE_ANSWER;

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

    if (subject.FOUNDERS?.FOUNDER) entity.founders = subject.FOUNDERS.FOUNDER;
    if (subject.BENEFICIARIES?.BENEFICIARY) entity.beneficiaries = subject.BENEFICIARIES.BENEFICIARY;
    if (subject.SIGNERS?.SIGNER) entity.signers = subject.SIGNERS.SIGNER;
    if (subject.PREDECESSORS?.PREDECESSOR) entity.predecessors = subject.PREDECESSORS.PREDECESSOR;
    if (subject.TERMINATION_STARTED_INFO) entity.termination_started = subject.TERMINATION_STARTED_INFO;
    if (subject.EXCHANGE_DATA?.EXCHANGE_ANSWER) entity.exchange_data = subject.EXCHANGE_DATA.EXCHANGE_ANSWER;

    return entity;
  }
}
