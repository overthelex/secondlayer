import { useForm } from "@refinedev/antd";
import { Form, Input, Button, Card, Typography, Select, Space } from "antd";
import { Save, ArrowLeft, FileText } from "lucide-react";
import { useNavigate } from "react-router-dom";

const { Title } = Typography;
const { TextArea } = Input;

export const DocumentEdit = () => {
  const navigate = useNavigate();
  const { formProps, saveButtonProps } = useForm();

  return (
    <div style={{ padding: 24 }}>
      <Button 
        icon={<ArrowLeft size={16} />} 
        onClick={() => navigate(-1)}
        style={{ marginBottom: 16 }}
      >
        Back
      </Button>

      <Title level={2} style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <FileText size={28} color="#06b6d4" />
        Edit Document
      </Title>

      <Card bordered={false}>
        <Form {...formProps} layout="vertical">
          <Form.Item
            label="Title"
            name="title"
            rules={[{ required: true, message: 'Please enter title' }]}
          >
            <Input placeholder="Document title" />
          </Form.Item>

          <Form.Item
            label="Type"
            name="type"
            rules={[{ required: true, message: 'Please select type' }]}
          >
            <Select placeholder="Select document type">
              <Select.Option value="court_decision">Court Decision</Select.Option>
              <Select.Option value="legal_act">Legal Act</Select.Option>
              <Select.Option value="contract">Contract</Select.Option>
              <Select.Option value="other">Other</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            label="Status"
            name="status"
          >
            <Select placeholder="Select status">
              <Select.Option value="pending">Pending</Select.Option>
              <Select.Option value="processing">Processing</Select.Option>
              <Select.Option value="processed">Processed</Select.Option>
              <Select.Option value="error">Error</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            label="Content"
            name="content"
          >
            <TextArea 
              rows={12} 
              placeholder="Document content"
              style={{ fontFamily: 'monospace' }}
            />
          </Form.Item>

          <Form.Item>
            <Space>
              <Button 
                type="primary" 
                icon={<Save size={16} />}
                {...saveButtonProps}
              >
                Save
              </Button>
              <Button onClick={() => navigate(-1)}>
                Cancel
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};
