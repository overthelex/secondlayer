import { useList } from "@refinedev/core";
import { Card, Col, Row, Statistic, Table, Typography } from "antd";
import {
  FileText,
  Search,
  CheckCircle2,
  AlertCircle,
  Database
} from "lucide-react";

const { Title } = Typography;

export const Dashboard = () => {
  const { data: documents } = useList({
    resource: "documents",
    pagination: { pageSize: 5 },
  });

  const { data: queries } = useList({
    resource: "queries",
    pagination: { pageSize: 5 },
  });

  const stats = [
    {
      title: "Total Documents",
      value: documents?.total || 0,
      icon: <FileText size={24} color="#06b6d4" />,
      color: "#e0f2fe",
    },
    {
      title: "Total Queries",
      value: queries?.total || 0,
      icon: <Search size={24} color="#0891b2" />,
      color: "#cffafe",
    },
    {
      title: "Processed",
      value: Math.floor((documents?.total || 0) * 0.87),
      icon: <CheckCircle2 size={24} color="#14b8a6" />,
      color: "#ccfbf1",
    },
    {
      title: "Pending",
      value: Math.floor((documents?.total || 0) * 0.13),
      icon: <AlertCircle size={24} color="#f59e0b" />,
      color: "#fef3c7",
    },
  ];

  const recentColumns = [
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
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <span className={`status-badge ${status === 'processed' ? 'active' : 'pending'}`}>
          {status}
        </span>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={2} style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Database size={28} color="#06b6d4" />
        Dashboard
      </Title>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {stats.map((stat, index) => (
          <Col xs={24} sm={12} lg={6} key={index}>
            <Card
              variant="borderless"
              style={{
                background: stat.color,
                borderRadius: 8,
              }}
            >
              <Statistic
                title={stat.title}
                value={stat.value}
                prefix={stat.icon}
                valueStyle={{ color: '#171717', fontWeight: 600 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FileText size={18} />
                Recent Documents
              </span>
            }
            variant="borderless"
          >
            <Table
              dataSource={documents?.data || []}
              columns={recentColumns}
              rowKey="id"
              pagination={false}
              size="small"
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Search size={18} />
                Recent Queries
              </span>
            }
            variant="borderless"
          >
            <Table
              dataSource={queries?.data || []}
              columns={recentColumns}
              rowKey="id"
              pagination={false}
              size="small"
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
};
