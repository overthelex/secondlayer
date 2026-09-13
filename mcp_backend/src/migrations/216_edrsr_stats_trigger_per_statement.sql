-- Migration 216: считать решения ЄДРСР постатейно, а не построчно
--
-- 156 поставил на edrsr_documents построчный триггер, который на каждую
-- вставленную строку делает UPDATE одной и той же строки jurisdiction_fulltext_stats.
-- Комментарий там говорит, что дельты выбраны «чтобы не делать дорогой COUNT(*) на
-- каждую запись», и это верно ровно до массовой вставки: суточная дельта в пару
-- тысяч строк проходит незаметно, а догоняющий импорт — нет.
--
-- 13.09.2026 ежедневный крон ЄДРСР впервые за десять дней добрался до базы и привёз
-- 543 тысячи накопившихся решений. Вставка умерла на пятой минуте:
--
--   ERROR: canceling statement due to statement timeout
--   CONTEXT: SQL statement "UPDATE jurisdiction_fulltext_stats SET
--            total_decisions = total_decisions + 1 ... WHERE jurisdiction_code = 'UA'"
--            PL/pgSQL function trg_jurisdiction_stats_edrsr_docs() line 4
--
-- Полмиллиона последовательных UPDATE одного и того же кортежа: каждая версия
-- строки живёт до конца транзакции, страница пухнет, и всё это сериализовано.
--
-- Постатейный триггер с переходной таблицей делает ровно один UPDATE на INSERT,
-- независимо от того, одна в нём строка или полмиллиона.
--
-- Пересчёт счётчика здесь НЕ делается намеренно: на момент миграции
-- total_decisions = 136 359 024 и count(*) по edrsr_documents = 136 359 024,
-- то есть построчный триггер значение не испортил, а COUNT(*) по 136M строк
-- под statement_timeout = 300s — лишний риск в миграции.
--
-- ⚠ Те же построчные триггеры висят на be_/ch_/cz_/de_/dk_ и прочих
-- *_court_decisions через trg_jurisdiction_stats_inline. Здесь они не трогаются:
-- у них другая функция (ещё и с веткой UPDATE по full_text), и массовый импорт
-- по ним сейчас не идёт. Тот же приём применим, когда дойдёт очередь.

-- DROP/CREATE TRIGGER берут ACCESS EXCLUSIVE на родителя и на каждую партицию.
-- Сама операция мгновенная, но если в этот момент идёт долгий SELECT по ЄДРСР,
-- миграция встанет в очередь за ним и заблокирует всех, кто придёт следом.
-- Лучше упасть и перезапуститься, чем заморозить выдачу решений.
SET lock_timeout = '30s';

-- ============================================================
-- Постатейная функция
-- ============================================================

CREATE OR REPLACE FUNCTION trg_jurisdiction_stats_edrsr_docs_stmt()
RETURNS TRIGGER AS $$
DECLARE
    v_delta BIGINT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT count(*) INTO v_delta FROM new_rows;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT -count(*) INTO v_delta FROM old_rows;
    ELSE
        RETURN NULL;
    END IF;

    -- Пустой INSERT ... ON CONFLICT DO NOTHING, не вставивший ничего, не должен
    -- трогать updated_at: по нему видно, когда данные действительно менялись.
    IF v_delta <> 0 THEN
        UPDATE jurisdiction_fulltext_stats SET
            total_decisions = total_decisions + v_delta,
            updated_at = NOW()
        WHERE jurisdiction_code = 'UA';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Замена триггеров
-- ============================================================

-- Построчный триггер объявлен на партиционированном родителе и склонирован в
-- каждую партицию; DROP на родителе снимает клоны вместе с ним.
DROP TRIGGER IF EXISTS trg_jstats_edrsr_docs ON edrsr_documents;

DROP TRIGGER IF EXISTS trg_jstats_edrsr_docs_ins ON edrsr_documents;
CREATE TRIGGER trg_jstats_edrsr_docs_ins
    AFTER INSERT ON edrsr_documents
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION trg_jurisdiction_stats_edrsr_docs_stmt();

DROP TRIGGER IF EXISTS trg_jstats_edrsr_docs_del ON edrsr_documents;
CREATE TRIGGER trg_jstats_edrsr_docs_del
    AFTER DELETE ON edrsr_documents
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION trg_jurisdiction_stats_edrsr_docs_stmt();

-- Старая построчная функция больше ничем не вызывается.
DROP FUNCTION IF EXISTS trg_jurisdiction_stats_edrsr_docs();
