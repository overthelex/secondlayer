import React, { useState, useEffect } from 'react';
import { Modal, Button, Typography, Spin, Alert, Checkbox, Tabs } from 'antd';
import ReactMarkdown from 'react-markdown';
import { FileTextOutlined, BookOutlined, FileProtectOutlined } from '@ant-design/icons';

const { Title, Paragraph } = Typography;
const { TabPane } = Tabs;

interface EULAModalProps {
  open: boolean;
  onAccept: () => Promise<void>;
  onClose?: () => void;
  requireAcceptance?: boolean; // If true, user must accept to continue
}

interface EULADocument {
  id: number;
  version: string;
  content: string;
  contentType: 'markdown' | 'html' | 'plain';
  isActive: boolean;
  createdAt: string;
  effectiveDate: string;
}

interface AllDocuments {
  eula: string;
  userManual: string;
  serviceAgreement: string;
}

export const EULAModal: React.FC<EULAModalProps> = ({
  open,
  onAccept,
  onClose,
  requireAcceptance = true,
}) => {
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eulaDocument, setEulaDocument] = useState<EULADocument | null>(null);
  const [allDocuments, setAllDocuments] = useState<AllDocuments | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [activeTab, setActiveTab] = useState('eula');

  useEffect(() => {
    if (open) {
      loadDocuments();
    }
  }, [open]);

  const loadDocuments = async () => {
    setLoading(true);
    setError(null);

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

      // Load EULA document
      const eulaResponse = await fetch(`${apiUrl}/eula`, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!eulaResponse.ok) {
        throw new Error('Failed to load EULA');
      }

      const eulaData = await eulaResponse.json();
      setEulaDocument(eulaData.data);

      // Load all documents (manual, agreement)
      const docsResponse = await fetch(`${apiUrl}/eula/documents`, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (docsResponse.ok) {
        const docsData = await docsResponse.json();
        setAllDocuments(docsData.data);
      }
    } catch (err) {
      console.error('Error loading documents:', err);
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async () => {
    if (!agreed && requireAcceptance) {
      setError('Ви повинні погодитися з умовами для продовження');
      return;
    }

    setAccepting(true);
    setError(null);

    try {
      await onAccept();
      setAgreed(false); // Reset for next time
    } catch (err) {
      console.error('Error accepting EULA:', err);
      setError(err instanceof Error ? err.message : 'Failed to accept EULA');
    } finally {
      setAccepting(false);
    }
  };

  const handleClose = () => {
    if (!requireAcceptance && onClose) {
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      title={
        <Title level={4} style={{ margin: 0 }}>
          <FileProtectOutlined style={{ marginRight: 8 }} />
          Юридичні документи
        </Title>
      }
      width={900}
      footer={[
        !requireAcceptance && (
          <Button key="close" onClick={handleClose}>
            Закрити
          </Button>
        ),
        <Button
          key="accept"
          type="primary"
          onClick={handleAccept}
          loading={accepting}
          disabled={!agreed && requireAcceptance}
        >
          {requireAcceptance ? 'Прийняти та продовжити' : 'Зберегти'}
        </Button>,
      ]}
      closable={!requireAcceptance}
      maskClosable={false}
      onCancel={handleClose}
      bodyStyle={{ maxHeight: '70vh', overflowY: 'auto' }}
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: '50px 0' }}>
          <Spin size="large" />
          <Paragraph style={{ marginTop: 16 }}>Завантаження документів...</Paragraph>
        </div>
      ) : error ? (
        <Alert
          message="Помилка"
          description={error}
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
        />
      ) : (
        <>
          <Tabs activeKey={activeTab} onChange={setActiveTab}>
            <TabPane
              tab={
                <span>
                  <FileProtectOutlined />
                  Ліцензійна угода (EULA)
                </span>
              }
              key="eula"
            >
              {eulaDocument && (
                <div style={{ padding: '16px 0' }}>
                  <ReactMarkdown>{eulaDocument.content}</ReactMarkdown>
                  <div style={{ marginTop: 16, fontSize: '12px', color: '#888' }}>
                    Версія: {eulaDocument.version} | Дата оновлення:{' '}
                    {new Date(eulaDocument.effectiveDate).toLocaleDateString('uk-UA')}
                  </div>
                </div>
              )}
            </TabPane>

            {allDocuments?.userManual && (
              <TabPane
                tab={
                  <span>
                    <BookOutlined />
                    Керівництво користувача
                  </span>
                }
                key="manual"
              >
                <div style={{ padding: '16px 0' }}>
                  <ReactMarkdown>{allDocuments.userManual}</ReactMarkdown>
                </div>
              </TabPane>
            )}

            {allDocuments?.serviceAgreement && (
              <TabPane
                tab={
                  <span>
                    <FileTextOutlined />
                    Договір про надання послуг
                  </span>
                }
                key="agreement"
              >
                <div style={{ padding: '16px 0' }}>
                  <ReactMarkdown>{allDocuments.serviceAgreement}</ReactMarkdown>
                </div>
              </TabPane>
            )}
          </Tabs>

          {requireAcceptance && (
            <div style={{ marginTop: 24, padding: 16, background: '#f0f2f5', borderRadius: 4 }}>
              <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)}>
                <strong>
                  Я прочитав(ла) та погоджуюся з умовами Ліцензійної угоди кінцевого
                  користувача (EULA)
                </strong>
              </Checkbox>
              <Paragraph style={{ marginTop: 8, marginBottom: 0, fontSize: '12px' }}>
                Продовжуючи використання платформи, ви підтверджуєте своє приєднання до умов
                угоди та згоду на обробку персональних даних відповідно до законодавства
                України та GDPR.
              </Paragraph>
            </div>
          )}
        </>
      )}
    </Modal>
  );
};
