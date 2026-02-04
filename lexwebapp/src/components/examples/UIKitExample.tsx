/**
 * UI Kit Example
 * Demonstrates usage of all UI components
 */

import React, { useState } from 'react';
import {
  Button,
  Input,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Modal,
  Badge,
  Checkbox,
  Switch,
  Spinner,
} from '../ui';
import { Search, Save, Trash2 } from 'lucide-react';

export function UIKitExample() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [switched, setSwitched] = useState(false);

  const handleSubmit = () => {
    setIsLoading(true);
    setTimeout(() => {
      setIsLoading(false);
      setIsModalOpen(false);
    }, 2000);
  };

  return (
    <div className="p-8 space-y-8 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900">UI Kit Components</h1>

      {/* Buttons */}
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-xl font-semibold">Buttons</h2>
        </CardHeader>
        <CardBody>
          <div className="flex flex-wrap gap-4">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button isLoading>Loading</Button>
            <Button leftIcon={<Save size={16} />}>With Icon</Button>
          </div>
        </CardBody>
      </Card>

      {/* Inputs */}
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-xl font-semibold">Inputs</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <Input
            label="Email"
            type="email"
            placeholder="Enter your email"
            helperText="We'll never share your email"
          />
          <Input
            label="Search"
            leftIcon={<Search size={18} />}
            placeholder="Search..."
          />
          <Input label="Error example" error="This field is required" />
          <Input variant="filled" placeholder="Filled variant" />
          <Input variant="flushed" placeholder="Flushed variant" />
        </CardBody>
      </Card>

      {/* Badges */}
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-xl font-semibold">Badges</h2>
        </CardHeader>
        <CardBody>
          <div className="flex flex-wrap gap-4">
            <Badge variant="default">Default</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="error">Error</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="info">Info</Badge>
            <Badge dot variant="success">
              Active
            </Badge>
            <Badge size="sm">Small</Badge>
            <Badge size="lg">Large</Badge>
          </div>
        </CardBody>
      </Card>

      {/* Form Controls */}
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-xl font-semibold">Form Controls</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <Checkbox
            label="Accept terms and conditions"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <Switch
            label="Enable notifications"
            checked={switched}
            onChange={(e) => setSwitched(e.target.checked)}
          />
          <Switch size="sm" label="Small switch" />
          <Switch size="lg" label="Large switch" />
        </CardBody>
      </Card>

      {/* Modal */}
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-xl font-semibold">Modal</h2>
        </CardHeader>
        <CardBody>
          <Button onClick={() => setIsModalOpen(true)}>Open Modal</Button>
        </CardBody>
      </Card>

      {/* Spinner */}
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-xl font-semibold">Spinner</h2>
        </CardHeader>
        <CardBody>
          <div className="flex gap-4">
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" />
            <Spinner size="xl" />
          </div>
        </CardBody>
      </Card>

      {/* Modal Component */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Example Modal"
        size="md"
      >
        <div className="space-y-4">
          <p className="text-gray-600">
            This is an example modal with animations and accessibility features.
          </p>

          <Input label="Name" placeholder="Enter your name" />

          <Checkbox label="I agree to the terms" />

          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isLoading={isLoading}
              onClick={handleSubmit}
            >
              Submit
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
