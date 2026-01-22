import { useForm } from "@refinedev/antd";
import { Form, Input, Button, Card, Typography, Select, Space, InputNumber } from "antd";
import { Plus, ArrowLeft, FileSearch } from "lucide-react";
import { useNavigate } from "react-router-dom";

const { Title } = Typography;
const { TextArea } = Input;

export const PatternCreate = () => {
  const navigate = useNavigate();
  const { formProps, saveButtonProps } = useForm();

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
        Create Legal Pattern
      </Title>

      <Card bordered={false}>
        <Form {...formProps} layout="vertical">
          <Form.Item
            label="Pattern Name"
            name="name"
            rules={[{ required: true, message: 'Please enter pattern name' }]}
          >
            <Input placeholder="Pattern name" />
          </Form.Item>

          <Form.Item
            label="Category"
            name="category"
            rules={[{ required: true, message: 'Please select category' }]}
          >
            <Select placeholder="Select category">
              <Select.Option value="citation">Citation Pattern</Select.Option>
              <Select.Option value="argument">Argument Pattern</Select.Option>
              <Select.Option value="precedent">Precedent Pattern</Select.Option>
              <Select.Option value="procedural">Procedural Pattern</Select.Option>
              <Select.Option value="other">Other</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            label="Confidence"
            name="confidence"
            initialValue={0.8}
            rules={[{ required: true, message: 'Please set confidence level' }]}
          >
            <InputNumber 
              min={0} 
              max={1} 
              step={0.1} 
              style={{ width: '100%' }}
              placeholder="0.0 - 1.0"
            />
          </Form.Item>

          <Form.Item
            label="Description"
            name="description"
            rules={[{ required: true, message: 'Please enter description' }]}
          >
            <TextArea 
              rows={6} 
              placeholder="Pattern description"
            />
          </Form.Item>

          <Form.Item
            label="Pattern Data (JSON)"
            name="pattern_data"
          >
            <TextArea 
              rows={10} 
              placeholder='{"key": "value"}'
              style={{ fontFamily: 'monospace' }}
            />
          </Form.Item>

          <Form.Item>
            <Space>
              <Button 
                type="primary" 
                icon={<Plus size={16} />}
                {...saveButtonProps}
              >
                Create
              </Button>
              <Button onClick={() => navigate("/patterns")}>
                Cancel
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};
