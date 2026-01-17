import { useShow } from "@refinedev/core";
import { Card, Descriptions, Typography, Button, Spin, Tag, List } from "antd";
import { ArrowLeft, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

const { Title, Paragraph } = Typography;

export const QueryShow = () => {
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

  return (
    <div style={{ padding: 24 }}>
      <Button 
        icon={<ArrowLeft size={16} />} 
        onClick={() => navigate("/queries")}
        style={{ marginBottom: 16 }}
      >
        Back
      </Button>

      <Title level={2} style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Search size={28} color="#06b6d4" />
        Query Details
      </Title>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card title="Query Information" bordered={false}>
          <Descriptions column={2} bordered>
            <Descriptions.Item label="ID">{record?.id}</Descriptions.Item>
            <Descriptions.Item label="Type">
              <Tag color="cyan">{record?.type}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Query" span={2}>
              <Paragraph copyable>{record?.query}</Paragraph>
            </Descriptions.Item>
            <Descriptions.Item label="Results Count">
              {record?.results_count}
            </Descriptions.Item>
            <Descriptions.Item label="Execution Time">
              {record?.execution_time}ms
            </Descriptions.Item>
            <Descriptions.Item label="Created" span={2}>
              {record?.created_at && new Date(record.created_at).toLocaleString('uk-UA')}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        {record?.results && (
          <Card title="Results" bordered={false}>
            <List
              dataSource={record.results}
              renderItem={(item: any, index: number) => (
                <List.Item>
                  <List.Item.Meta
                    title={`Result ${index + 1}`}
                    description={
                      <pre style={{ 
                        background: '#fafafa', 
                        padding: 12, 
                        borderRadius: 6,
                        marginTop: 8 
                      }}>
                        {JSON.stringify(item, null, 2)}
                      </pre>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        )}
      </div>
    </div>
  );
};
