import { useShow } from "@refinedev/core";
import { Card, Descriptions, Typography, Button, Spin, Tag, Progress } from "antd";
import { ArrowLeft, FileSearch } from "lucide-react";
import { useNavigate } from "react-router-dom";

const { Title, Paragraph } = Typography;

export const PatternShow = () => {
  const navigate = useNavigate();
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

  const confidence = record?.confidence ? record.confidence * 100 : 0;

  return (
    <div style={{ padding: 24 }}>
      <Button 
        icon={<ArrowLeft size={16} />} 
        onClick={() => navigate("/patterns")}
        style={{ marginBottom: 16 }}
      >
        Back
      </Button>

      <Title level={2} style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <FileSearch size={28} color="#06b6d4" />
        Pattern Details
      </Title>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card title="Pattern Information" bordered={false}>
          <Descriptions column={2} bordered>
            <Descriptions.Item label="ID">{record?.id}</Descriptions.Item>
            <Descriptions.Item label="Category">
              <Tag color="blue">{record?.category}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Name" span={2}>
              {record?.name}
            </Descriptions.Item>
            <Descriptions.Item label="Usage Count">
              {record?.usage_count || 0}
            </Descriptions.Item>
            <Descriptions.Item label="Confidence">
              <Progress 
                percent={confidence} 
                size="small" 
                strokeColor="#06b6d4"
                style={{ width: 200 }}
              />
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Description" bordered={false}>
          <Paragraph style={{ whiteSpace: 'pre-wrap' }}>
            {record?.description || 'No description available'}
          </Paragraph>
        </Card>

        {record?.pattern_data && (
          <Card title="Pattern Data" bordered={false}>
            <pre style={{ 
              background: '#fafafa', 
              padding: 16, 
              borderRadius: 6,
              overflow: 'auto'
            }}>
              {JSON.stringify(record.pattern_data, null, 2)}
            </pre>
          </Card>
        )}
      </div>
    </div>
  );
};
