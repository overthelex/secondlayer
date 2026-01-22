import { useShow } from "@refinedev/core";
import { Card, Descriptions, Typography, Space, Button, Spin } from "antd";
import { ArrowLeft, Edit, FileText } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

const { Title, Paragraph } = Typography;

export const DocumentShow = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { queryResult } = useShow();
  const { data, isLoading } = queryResult;
  const record = data?.data;

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 24 }}>
        <Button 
          icon={<ArrowLeft size={16} />} 
          onClick={() => navigate("/documents")}
          style={{ marginBottom: 16 }}
        >
          Back
        </Button>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={2} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
            <FileText size={28} color="#06b6d4" />
            Document Details
          </Title>
          <Button
            type="primary"
            icon={<Edit size={16} />}
            onClick={() => navigate(`/documents/${id}/edit`)}
          >
            Edit
          </Button>
        </div>
      </div>

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card title="General Information" bordered={false}>
          <Descriptions column={2} bordered>
            <Descriptions.Item label="ID">{record?.id}</Descriptions.Item>
            <Descriptions.Item label="Type">{record?.type}</Descriptions.Item>
            <Descriptions.Item label="Title" span={2}>{record?.title}</Descriptions.Item>
            <Descriptions.Item label="Status">
              <span className={`status-badge ${record?.status === 'processed' ? 'active' : 'pending'}`}>
                {record?.status}
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="Created">
              {record?.created_at && new Date(record.created_at).toLocaleString('uk-UA')}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Content" bordered={false}>
          <Paragraph style={{ whiteSpace: 'pre-wrap' }}>
            {record?.content || 'No content available'}
          </Paragraph>
        </Card>

        {record?.metadata && (
          <Card title="Metadata" bordered={false}>
            <pre style={{ background: '#fafafa', padding: 16, borderRadius: 6 }}>
              {JSON.stringify(record.metadata, null, 2)}
            </pre>
          </Card>
        )}
      </Space>
    </div>
  );
};
