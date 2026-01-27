-- OPENREYESTR Database Schema
-- Ukrainian Unified State Register of Legal Entities, Individual Entrepreneurs and Public Associations

-- Legal Entities (Юридичні особи)
CREATE TABLE IF NOT EXISTS legal_entities (
    id SERIAL PRIMARY KEY,
    record VARCHAR(50) UNIQUE NOT NULL,  -- Унікальний ідентифікатор в реєстрі
    edrpou VARCHAR(20),  -- Код ЄДРПОУ
    name TEXT NOT NULL,  -- Найменування
    short_name TEXT,  -- Скорочене найменування
    opf TEXT,  -- Організаційно-правова форма
    stan VARCHAR(100),  -- Стан діяльності
    authorized_capital DECIMAL(18, 2),  -- Статутний капітал
    founding_document_num TEXT,  -- Код модельного статуту
    purpose TEXT,  -- Мета діяльності
    superior_management TEXT,  -- Органи управління
    statute TEXT,  -- Відомості про установчі документи
    registration TEXT,  -- Дата та номер реєстрації
    managing_paper TEXT,  -- Розпорядчий акт
    terminated_info TEXT,  -- Інформація про припинення
    termination_cancel_info TEXT,  -- Відміна припинення
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Individual Entrepreneurs (Фізичні особи-підприємці)
CREATE TABLE IF NOT EXISTS individual_entrepreneurs (
    id SERIAL PRIMARY KEY,
    record VARCHAR(50) UNIQUE NOT NULL,  -- Унікальний ідентифікатор
    name TEXT NOT NULL,  -- Прізвище, ім'я, по батькові
    stan VARCHAR(100),  -- Стан діяльності
    farmer VARCHAR(10),  -- Ознака фермерського господарства
    estate_manager TEXT,  -- Управитель майна
    registration TEXT,  -- Дата та номер реєстрації
    terminated_info TEXT,  -- Інформація про припинення
    termination_cancel_info TEXT,  -- Відміна припинення
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Public Associations / Separated Divisions (Громадські формування / Відокремлені підрозділи)
CREATE TABLE IF NOT EXISTS public_associations (
    id SERIAL PRIMARY KEY,
    record VARCHAR(50) UNIQUE NOT NULL,  -- Унікальний ідентифікатор
    edrpou VARCHAR(20),  -- Код ЄДРПОУ
    name TEXT NOT NULL,  -- Найменування
    short_name TEXT,  -- Скорочене найменування
    type_subject VARCHAR(200),  -- Вид суб'єкта
    type_branch VARCHAR(200),  -- Вид відокремленого підрозділу
    stan VARCHAR(100),  -- Стан діяльності
    founding_document TEXT,  -- Вид установчого документа
    registration TEXT,  -- Дата реєстрації
    terminated_info TEXT,  -- Інформація про припинення
    termination_cancel_info TEXT,  -- Відміна припинення
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Founders (Засновники)
CREATE TABLE IF NOT EXISTS founders (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(10) NOT NULL,  -- 'UO', 'FOP', 'FSU'
    entity_record VARCHAR(50) NOT NULL,  -- Reference to parent entity
    founder_info TEXT NOT NULL,  -- Full founder information
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Beneficiaries (Бенефіціари)
CREATE TABLE IF NOT EXISTS beneficiaries (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(10) NOT NULL,  -- 'UO', 'FOP', 'FSU'
    entity_record VARCHAR(50) NOT NULL,  -- Reference to parent entity
    beneficiary_info TEXT NOT NULL,  -- Full beneficiary information
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Signers (Підписанти / Керівники)
CREATE TABLE IF NOT EXISTS signers (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(10) NOT NULL,  -- 'UO', 'FOP', 'FSU'
    entity_record VARCHAR(50) NOT NULL,  -- Reference to parent entity
    signer_info TEXT NOT NULL,  -- Full signer information
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Members (Члени керівних органів)
CREATE TABLE IF NOT EXISTS members (
    id SERIAL PRIMARY KEY,
    entity_record VARCHAR(50) NOT NULL,  -- Reference to legal entity
    member_info TEXT NOT NULL,  -- Full member information
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Branches (Філії та представництва)
CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    parent_record VARCHAR(50) NOT NULL,  -- Reference to parent legal entity
    code VARCHAR(20),  -- Branch EDRPOU code
    name TEXT NOT NULL,
    signer TEXT,
    create_date VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Predecessors (Правопопередники)
CREATE TABLE IF NOT EXISTS predecessors (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(10) NOT NULL,  -- 'UO', 'FSU'
    entity_record VARCHAR(50) NOT NULL,  -- Reference to current entity
    predecessor_name TEXT,
    predecessor_code VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Assignees (Правонаступники)
CREATE TABLE IF NOT EXISTS assignees (
    id SERIAL PRIMARY KEY,
    entity_record VARCHAR(50) NOT NULL,  -- Reference to current entity
    assignee_name TEXT,
    assignee_code VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Executive Power (Виконавча влада)
CREATE TABLE IF NOT EXISTS executive_power (
    id SERIAL PRIMARY KEY,
    entity_record VARCHAR(50) NOT NULL,  -- Reference to legal entity
    name TEXT,
    code VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Termination Started Info (Перебування у процесі припинення)
CREATE TABLE IF NOT EXISTS termination_started (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(10) NOT NULL,  -- 'UO', 'FSU'
    entity_record VARCHAR(50) NOT NULL,
    op_date VARCHAR(50),
    reason TEXT,
    sbj_state TEXT,
    signer_name TEXT,
    creditor_req_end_date VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bankruptcy/Readjustment Info (Банкрутство/санація)
CREATE TABLE IF NOT EXISTS bankruptcy_info (
    id SERIAL PRIMARY KEY,
    entity_record VARCHAR(50) NOT NULL,  -- Reference to legal entity
    op_date VARCHAR(50),
    reason TEXT,
    sbj_state TEXT,
    head_name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Exchange Data (Дані обміну з державними органами)
CREATE TABLE IF NOT EXISTS exchange_data (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(10) NOT NULL,  -- 'UO', 'FOP', 'FSU'
    entity_record VARCHAR(50) NOT NULL,
    tax_payer_type TEXT,
    start_date VARCHAR(50),
    start_num VARCHAR(100),
    end_date VARCHAR(50),
    end_num VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_legal_entities_edrpou ON legal_entities(edrpou);
CREATE INDEX idx_legal_entities_name ON legal_entities USING gin(to_tsvector('russian', name));
CREATE INDEX idx_legal_entities_record ON legal_entities(record);
CREATE INDEX idx_legal_entities_stan ON legal_entities(stan);

CREATE INDEX idx_individual_entrepreneurs_record ON individual_entrepreneurs(record);
CREATE INDEX idx_individual_entrepreneurs_name ON individual_entrepreneurs USING gin(to_tsvector('russian', name));
CREATE INDEX idx_individual_entrepreneurs_stan ON individual_entrepreneurs(stan);

CREATE INDEX idx_public_associations_edrpou ON public_associations(edrpou);
CREATE INDEX idx_public_associations_name ON public_associations USING gin(to_tsvector('russian', name));
CREATE INDEX idx_public_associations_record ON public_associations(record);
CREATE INDEX idx_public_associations_stan ON public_associations(stan);

CREATE INDEX idx_founders_entity ON founders(entity_type, entity_record);
CREATE INDEX idx_beneficiaries_entity ON beneficiaries(entity_type, entity_record);
CREATE INDEX idx_signers_entity ON signers(entity_type, entity_record);
CREATE INDEX idx_members_entity ON members(entity_record);
CREATE INDEX idx_branches_parent ON branches(parent_record);
CREATE INDEX idx_predecessors_entity ON predecessors(entity_type, entity_record);
CREATE INDEX idx_assignees_entity ON assignees(entity_record);
CREATE INDEX idx_exchange_data_entity ON exchange_data(entity_type, entity_record);
