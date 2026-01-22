import { useTable } from "@refinedev/antd";
import { Table, Button, Input, Card, Typography, Tag } from "antd";
import { Eye, Plus, Search, FileSearch } from "lucide-react";
import { useNavigate } from "react-router-dom";

const { Title } = Typography;

export const PatternList = () => {
  const navigate = useNavigate();
  const { tableProps } = useTable({
    syncWithLocation: true,
  });

  const columns = [
    {
      title: "ID",
      dataIndex: "id",
      key: "id",
      width: 80,
    },
    {
      title: "Pattern Name",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
    },
    {
      title: "Category",
      dataIndex: "category",
      key: "category",
      width: 150,
      render: (category: string) => <Tag color="blue">{category}</Tag>,
    },
    {
      title: "Usage Count",
      dataIndex: "usage_count",
      key: "usage_count",
      width: 120,
    },
    {
      title: "Confidence",
      dataIndex: "confidence",
      key: "confidence",
      width: 120,
      render: (confidence: number) => `${(confidence * 100).toFixed(0)}%`,
    },
    {
      title: "Actions",
      key: "actions",
      width: 80,
      render: (_: any, record: any) => (
        <Button
          type="text"
          icon={<Eye size={16} />}
          onClick={() => navigate(`/patterns/${record.id}`)}
        />
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Title level={2} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
          <FileSearch size={28} color="#06b6d4" />
          Legal Patterns
        </Title>
        <Button
          type="primary"
          icon={<Plus size={18} />}
          onClick={() => navigate("/patterns/create")}
        >
          New Pattern
        </Button>
      </div>

      <Card variant="borderless">
        <div style={{ marginBottom: 16 }}>
          <Input
            placeholder="Search patterns..."
            prefix={<Search size={16} color="#a3a3a3" />}
            style={{ width: 300 }}
          />
        </div>
        
        <Table 
          {...tableProps} 
          columns={columns}
          rowKey="id"
          pagination={{
            ...tableProps.pagination,
            showSizeChanger: true,
            showTotal: (total) => `Total ${total} patterns`,
          }}
        />
      </Card>
    </div>
  );
};
