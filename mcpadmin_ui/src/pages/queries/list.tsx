import { useTable } from "@refinedev/antd";
import { Table, Button, Input, Card, Typography, Tag } from "antd";
import { Eye, Search as SearchIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";

const { Title } = Typography;

export const QueryList = () => {
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
      title: "Query",
      dataIndex: "query",
      key: "query",
      ellipsis: true,
    },
    {
      title: "Type",
      dataIndex: "type",
      key: "type",
      width: 150,
      render: (type: string) => <Tag color="cyan">{type}</Tag>,
    },
    {
      title: "Results",
      dataIndex: "results_count",
      key: "results_count",
      width: 100,
    },
    {
      title: "Execution Time",
      dataIndex: "execution_time",
      key: "execution_time",
      width: 140,
      render: (time: number) => `${time}ms`,
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
      width: 80,
      render: (_: any, record: any) => (
        <Button
          type="text"
          icon={<Eye size={16} />}
          onClick={() => navigate(`/queries/${record.id}`)}
        />
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={2} style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <SearchIcon size={28} color="#06b6d4" />
        Queries
      </Title>

      <Card variant="borderless">
        <div style={{ marginBottom: 16 }}>
          <Input
            placeholder="Search queries..."
            prefix={<SearchIcon size={16} color="#a3a3a3" />}
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
            showTotal: (total) => `Total ${total} queries`,
          }}
        />
      </Card>
    </div>
  );
};
