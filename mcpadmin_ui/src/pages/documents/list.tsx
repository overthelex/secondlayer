import { useTable } from "@refinedev/antd";
import { Table, Space, Button, Input, Card, Typography } from "antd";
import { Eye, Edit, Plus, Search, FileText } from "lucide-react";
import { useNavigate } from "react-router-dom";

const { Title } = Typography;

export const DocumentList = () => {
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
      title: "Title",
      dataIndex: "title",
      key: "title",
      ellipsis: true,
    },
    {
      title: "Type",
      dataIndex: "type",
      key: "type",
      width: 150,
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (status: string) => (
        <span className={`status-badge ${status === 'processed' ? 'active' : status === 'error' ? 'error' : 'pending'}`}>
          {status}
        </span>
      ),
    },
    {
      title: "Created",
      dataIndex: "created_at",
      key: "created_at",
      width: 180,
      render: (date: string) => new Date(date).toLocaleDateString('uk-UA'),
    },
    {
      title: "Actions",
      key: "actions",
      width: 120,
      render: (_: any, record: any) => (
        <Space>
          <Button
            type="text"
            icon={<Eye size={16} />}
            onClick={() => navigate(`/documents/${record.id}`)}
          />
          <Button
            type="text"
            icon={<Edit size={16} />}
            onClick={() => navigate(`/documents/${record.id}/edit`)}
          />
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Title level={2} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
          <FileText size={28} color="#06b6d4" />
          Documents
        </Title>
        <Button
          type="primary"
          icon={<Plus size={18} />}
          onClick={() => navigate("/documents/create")}
        >
          New Document
        </Button>
      </div>

      <Card variant="borderless">
        <div style={{ marginBottom: 16 }}>
          <Input
            placeholder="Search documents..."
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
            showTotal: (total) => `Total ${total} documents`,
          }}
        />
      </Card>
    </div>
  );
};
