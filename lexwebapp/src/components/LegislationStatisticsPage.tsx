import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  TrendingUp,
  TrendingDown,
  Clock,
  BarChart3,
  PieChart,
  Download,
  Printer,
  ArrowLeft,
  ChevronDown,
  Activity } from
'lucide-react';
interface LegislationStatisticsPageProps {
  onBack?: () => void;
}
const monthlyData = [
{
  month: 'Січ',
  registered: 98,
  approved: 34,
  successRate: 35
},
{
  month: 'Лют',
  registered: 112,
  approved: 42,
  successRate: 38
},
{
  month: 'Бер',
  registered: 89,
  approved: 31,
  successRate: 35
},
{
  month: 'Квіт',
  registered: 125,
  approved: 48,
  successRate: 38
},
{
  month: 'Трав',
  registered: 95,
  approved: 36,
  successRate: 38
},
{
  month: 'Черв',
  registered: 108,
  approved: 41,
  successRate: 38
},
{
  month: 'Лип',
  registered: 87,
  approved: 29,
  successRate: 33
},
{
  month: 'Серп',
  registered: 92,
  approved: 33,
  successRate: 36
},
{
  month: 'Вер',
  registered: 103,
  approved: 39,
  successRate: 38
},
{
  month: 'Жовт',
  registered: 118,
  approved: 45,
  successRate: 38
},
{
  month: 'Лист',
  registered: 101,
  approved: 38,
  successRate: 38
},
{
  month: 'Груд',
  registered: 106,
  approved: 40,
  successRate: 38
}];

const committeeData = [
{
  name: 'Правової політики',
  count: 156
},
{
  name: 'Бюджету',
  count: 134
},
{
  name: 'Економічного розвитку',
  count: 98
},
{
  name: 'Соціальної політики',
  count: 87
},
{
  name: 'Закордонних справ',
  count: 65
}];

const typeDistribution = [
{
  type: 'Закони',
  count: 205,
  percentage: 45,
  color: 'from-blue-500 to-blue-600'
},
{
  type: 'Постанови',
  count: 137,
  percentage: 30,
  color: 'from-green-500 to-green-600'
},
{
  type: 'Звернення',
  count: 68,
  percentage: 15,
  color: 'from-amber-500 to-amber-600'
},
{
  type: 'Інше',
  count: 46,
  percentage: 10,
  color: 'from-gray-500 to-gray-600'
}];

const comparisonData = {
  ix: {
    registered: 1234,
    approved: 456,
    successRate: 37,
    avgTime: 127
  },
  viii: {
    registered: 2567,
    approved: 892,
    successRate: 35,
    avgTime: 145
  },
  vii: {
    registered: 1890,
    approved: 623,
    successRate: 33,
    avgTime: 156
  }
};
export function LegislationStatisticsPage({
  onBack
}: LegislationStatisticsPageProps) {
  const [period, setPeriod] = useState('2024');
  const [convocation, setConvocation] = useState('ix');
  const [showComparison, setShowComparison] = useState(false);
  const [selectedConvocations, setSelectedConvocations] = useState<string[]>([
  'ix',
  'viii']
  );
  const [comparisonMetric, setComparisonMetric] = useState('approved');
  const maxRegistered = Math.max(...monthlyData.map((d) => d.registered));
  const maxApproved = Math.max(...monthlyData.map((d) => d.approved));
  const maxCommittee = Math.max(...committeeData.map((c) => c.count));
  const toggleConvocation = (conv: string) => {
    if (selectedConvocations.includes(conv)) {
      if (selectedConvocations.length > 1) {
        setSelectedConvocations(selectedConvocations.filter((c) => c !== conv));
      }
    } else {
      if (selectedConvocations.length < 3) {
        setSelectedConvocations([...selectedConvocations, conv]);
      }
    }
  };
  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            duration: 0.5,
            ease: [0.22, 1, 0.36, 1]
          }}>

          <div className="flex items-center gap-4 mb-6">
            {onBack &&
            <button
              onClick={onBack}
              className="p-2 hover:bg-white rounded-lg transition-colors border border-claude-border">

                <ArrowLeft size={20} className="text-claude-text" />
              </button>
            }
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <Activity size={32} className="text-claude-accent" />
                <h1 className="text-3xl md:text-4xl font-sans text-claude-text font-medium tracking-tight">
                  Статистика законодавчої діяльності
                </h1>
              </div>
              <p className="text-claude-subtext font-sans text-sm">
                Аналіз ефективності прийняття законів
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>);

}