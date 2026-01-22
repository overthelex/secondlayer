import React from 'react';
import { useGetIdentity } from '@refinedev/core';
import { Avatar, Space, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface User {
  id: number;
  email: string;
  name?: string;
  avatar?: string;
}

export const UserFooter: React.FC = () => {
  const { data: user } = useGetIdentity<User>();

  if (!user) {
    return null;
  }

  return (
    <div
      style={{
        padding: '12px 16px',
        borderTop: '1px solid #f0f0f0',
        backgroundColor: '#fafafa',
      }}
    >
      <Space align="center" size={12}>
        <Avatar
          size={32}
          src={user.avatar}
          icon={!user.avatar && <UserOutlined />}
          style={{
            backgroundColor: user.avatar ? 'transparent' : '#06b6d4',
          }}
        />
        <div style={{ flex: 1 }}>
          <Text
            strong
            style={{
              display: 'block',
              fontSize: 14,
              color: '#262626',
              lineHeight: '20px',
            }}
          >
            {user.name || user.email}
          </Text>
          {user.name && (
            <Text
              type="secondary"
              style={{
                display: 'block',
                fontSize: 12,
                lineHeight: '16px',
              }}
            >
              {user.email}
            </Text>
          )}
        </div>
      </Space>
    </div>
  );
};
