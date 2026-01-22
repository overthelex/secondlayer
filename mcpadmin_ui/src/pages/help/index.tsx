import React, { useState, useEffect } from 'react';
import { Card, Tabs, Spin, Alert, Typography, Button, Space } from 'antd';
import { BookOutlined, FileTextOutlined, FileProtectOutlined, DownloadOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import axios from 'axios';

const { Title, Paragraph } = Typography;
const { TabPane } = Tabs;

interface AllDocuments {
  eula: string;
  userManual: string;
  serviceAgreement: string;
}

export const HelpPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<AllDocuments | null>(null);
  const [activeTab, setActiveTab] = useState('manual');

  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

  useEffect(() => {
    loadDocuments();
  }, []);

  const loadDocuments = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.get(`${apiUrl}/eula/documents`);

      if (response.data.success) {
        setDocuments(response.data.data);
      }
    } catch (err) {
      console.error('Error loading documents:', err);
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  const downloadDocument = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: '50px 0' }}>
          <Spin size="large" />
          <Paragraph style={{ marginTop: 16 }}>Завантаження документації...</Paragraph>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <Alert
          message="Помилка завантаження"
          description={error}
          type="error"
          showIcon
          action={
            <Button size="small" onClick={loadDocuments}>
              Спробувати знову
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title level={2}>
          <BookOutlined style={{ marginRight: 8 }} />
          Довідка та документація
        </Title>
        <Paragraph>
          Повний посібник користувача системи Lex, юридичні документи та угоди про надання
          послуг.
        </Paragraph>
      </div>

      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          tabBarExtraContent={
            activeTab === 'manual' && documents?.userManual ? (
              <Button
                icon={<DownloadOutlined />}
                onClick={() =>
                  downloadDocument(documents.userManual, 'Lex_User_Manual.md')
                }
              >
                Завантажити
              </Button>
            ) : null
          }
        >
          <TabPane
            tab={
              <span>
                <BookOutlined />
                Керівництво користувача
              </span>
            }
            key="manual"
          >
            {documents?.userManual ? (
              <div style={{ padding: '16px 0' }}>
                <div
                  style={{
                    maxWidth: '900px',
                    margin: '0 auto',
                    lineHeight: 1.8,
                  }}
                >
                  <ReactMarkdown
                    components={{
                      h1: ({ children }) => (
                        <Title level={1} style={{ marginTop: 32 }}>{children}</Title>
                      ),
                      h2: ({ children }) => (
                        <Title level={2} style={{ marginTop: 24 }}>{children}</Title>
                      ),
                      h3: ({ children }) => (
                        <Title level={3} style={{ marginTop: 20 }}>{children}</Title>
                      ),
                      h4: ({ children }) => (
                        <Title level={4} style={{ marginTop: 16 }}>{children}</Title>
                      ),
                      p: ({ children }) => <Paragraph>{children}</Paragraph>,
                    }}
                  >
                    {documents.userManual}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <Alert
                message="Документ недоступний"
                type="warning"
                showIcon
              />
            )}
          </TabPane>

          <TabPane
            tab={
              <span>
                <FileTextOutlined />
                Договір про надання послуг
              </span>
            }
            key="agreement"
          >
            {documents?.serviceAgreement ? (
              <div style={{ padding: '16px 0' }}>
                <Space style={{ marginBottom: 16 }}>
                  <Button
                    icon={<DownloadOutlined />}
                    onClick={() =>
                      downloadDocument(
                        documents.serviceAgreement,
                        'Lex_Service_Agreement.md'
                      )
                    }
                  >
                    Завантажити договір
                  </Button>
                </Space>

                <div
                  style={{
                    maxWidth: '900px',
                    margin: '0 auto',
                    lineHeight: 1.8,
                  }}
                >
                  <ReactMarkdown
                    components={{
                      h1: ({ children }) => (
                        <Title level={1} style={{ marginTop: 32 }}>{children}</Title>
                      ),
                      h2: ({ children }) => (
                        <Title level={2} style={{ marginTop: 24 }}>{children}</Title>
                      ),
                      h3: ({ children }) => (
                        <Title level={3} style={{ marginTop: 20 }}>{children}</Title>
                      ),
                      h4: ({ children }) => (
                        <Title level={4} style={{ marginTop: 16 }}>{children}</Title>
                      ),
                      p: ({ children }) => <Paragraph>{children}</Paragraph>,
                    }}
                  >
                    {documents.serviceAgreement}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <Alert
                message="Документ недоступний"
                type="warning"
                showIcon
              />
            )}
          </TabPane>

          <TabPane
            tab={
              <span>
                <FileProtectOutlined />
                Ліцензійна угода (EULA)
              </span>
            }
            key="eula"
          >
            {documents?.eula ? (
              <div style={{ padding: '16px 0' }}>
                <Space style={{ marginBottom: 16 }}>
                  <Button
                    icon={<DownloadOutlined />}
                    onClick={() =>
                      downloadDocument(documents.eula, 'Lex_EULA.md')
                    }
                  >
                    Завантажити EULA
                  </Button>
                </Space>

                <div
                  style={{
                    maxWidth: '900px',
                    margin: '0 auto',
                    lineHeight: 1.8,
                  }}
                >
                  <ReactMarkdown
                    components={{
                      h1: ({ children }) => (
                        <Title level={1} style={{ marginTop: 32 }}>{children}</Title>
                      ),
                      h2: ({ children }) => (
                        <Title level={2} style={{ marginTop: 24 }}>{children}</Title>
                      ),
                      h3: ({ children }) => (
                        <Title level={3} style={{ marginTop: 20 }}>{children}</Title>
                      ),
                      h4: ({ children }) => (
                        <Title level={4} style={{ marginTop: 16 }}>{children}</Title>
                      ),
                      p: ({ children }) => <Paragraph>{children}</Paragraph>,
                    }}
                  >
                    {documents.eula}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <Alert
                message="Документ недоступний"
                type="warning"
                showIcon
              />
            )}
          </TabPane>
        </Tabs>
      </Card>
    </div>
  );
};
