"use client";

import React, { useState, useEffect } from 'react';
import { Power, AlertTriangle, CheckCircle, Clock, Zap, Activity } from 'lucide-react';

interface Feeder {
  id: string;
  name: string;
  band: string;
  status: 'online' | 'offline' | 'maintenance' | 'alarm';
  voltage: number;
  current: number;
  load: number;
  availability: number;
  lastOutage: string;
  totalOutages: number;
  customers: number;
  location: string;
}

const ElectricityDashboard: React.FC = () => {
  // Set currentTime initially null to prevent SSR/client mismatch
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  
  const [feeders, setFeeders] = useState<Feeder[]>([
    {
      id: 'OSL-11KV',
      name: 'Osolo 11kV Feeder',
      band: 'Band A',
      status: 'online',
      voltage: 11.0,
      current: 265,
      load: 72,
      availability: 98.8,
      lastOutage: '4 days ago',
      totalOutages: 3,
      customers: 1650,
      location: 'Osolo Estate, Isolo'
    },
    {
      id: 'ASW-11KV', 
      name: 'Aswani 11kV Feeder',
      band: 'Band A',
      status: 'online',
      voltage: 10.9,
      current: 240,
      load: 68,
      availability: 98.5,
      lastOutage: '5 days ago',
      totalOutages: 4,
      customers: 1820,
      location: 'Aswani Market Area, Isolo'
    },
    {
      id: 'ADM-11KV',
      name: 'Ademulegun 11kV Feeder',
      band: 'Band B',
      status: 'online',
      voltage: 11.1,
      current: 180,
      load: 55,
      availability: 96.2,
      lastOutage: '2 days ago',
      totalOutages: 8,
      customers: 1100,
      location: 'Ademulegun Street, Isolo'
    },
    {
      id: 'IBX-11KV',
      name: 'Ibalex 11kV Feeder',
      band: 'Band C',
      status: 'alarm',
      voltage: 10.3,
      current: 420,
      load: 96,
      availability: 94.8,
      lastOutage: '1 hour ago',
      totalOutages: 12,
      customers: 950,
      location: 'Ibalex Industrial Area, Isolo'
    },
    {
      id: 'IRE-11KV',
      name: 'Ire-Akari 11kV Feeder',
      band: 'Band C',
      status: 'maintenance',
      voltage: 0,
      current: 0,
      load: 0,
      availability: 93.5,
      lastOutage: 'Now (Scheduled)',
      totalOutages: 15,
      customers: 720,
      location: 'Ire-Akari Estate, Isolo'
    }
  ]);

  // Update time every second only after mount
  useEffect(() => {
    setCurrentTime(new Date()); // Set initial time on client mount
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Simulate real-time data updates
  useEffect(() => {
    const updateInterval = setInterval(() => {
      setFeeders(prevFeeders => 
        prevFeeders.map(feeder => ({
          ...feeder,
          voltage: feeder.status === 'online' ? 
            Math.max(10.5, Math.min(11.5, feeder.voltage + (Math.random() - 0.5) * 0.2)) : 
            feeder.voltage,
          current: feeder.status === 'online' ? 
            Math.max(0, feeder.current + (Math.random() - 0.5) * 20) : 
            feeder.current,
          load: feeder.status === 'online' ? 
            Math.max(0, Math.min(100, feeder.load + (Math.random() - 0.5) * 5)) : 
            feeder.load
        }))
      );
    }, 3000);
    
    return () => clearInterval(updateInterval);
  }, []);

  const getStatusColor = (status: Feeder['status']): string => {
    switch (status) {
      case 'online': return 'text-green-600 bg-green-100';
      case 'offline': return 'text-red-600 bg-red-100';
      case 'maintenance': return 'text-yellow-600 bg-yellow-100';
      case 'alarm': return 'text-orange-600 bg-orange-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  const getStatusIcon = (status: Feeder['status']) => {
    switch (status) {
      case 'online': return <CheckCircle className="w-5 h-5" />;
      case 'offline': return <AlertTriangle className="w-5 h-5" />;
      case 'maintenance': return <Clock className="w-5 h-5" />;
      case 'alarm': return <AlertTriangle className="w-5 h-5" />;
      default: return <Power className="w-5 h-5" />;
    }
  };

  const getLoadColor = (load: number): string => {
    if (load >= 95) return 'bg-red-500';
    if (load >= 80) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  const getBandColor = (band: string): string => {
    switch (band) {
      case 'Band A': return 'bg-green-100 text-green-800 border-green-200';
      case 'Band B': return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'Band C': return 'bg-purple-100 text-purple-800 border-purple-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const totalCustomers = feeders.reduce((sum, feeder) => sum + feeder.customers, 0);
  const onlineFeeders = feeders.filter(f => f.status === 'online').length;
  const avgAvailability = feeders.reduce((sum, feeder) => sum + feeder.availability, 0) / feeders.length;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Zap className="w-8 h-8 text-blue-600" />
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Isolo UT - Ikeja Electric</h1>
              <p className="text-gray-600">11kV Feeder Availability Dashboard</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Last Updated</p>
            {currentTime ? (
              <>
                <p className="text-lg font-semibold">{currentTime.toLocaleTimeString()}</p>
                <p className="text-sm text-gray-500">{currentTime.toLocaleDateString()}</p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold">Loading...</p>
                <p className="text-sm text-gray-500">&nbsp;</p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow-sm border">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Isolo UT Feeders</p>
              <p className="text-2xl font-bold text-gray-900">{feeders.length}</p>
            </div>
            <Power className="w-8 h-8 text-blue-500" />
          </div>
        </div>
        
        <div className="bg-white p-6 rounded-lg shadow-sm border">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Online Feeders</p>
              <p className="text-2xl font-bold text-green-600">{onlineFeeders}</p>
            </div>
            <CheckCircle className="w-8 h-8 text-green-500" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-sm border">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Average Availability</p>
              <p className="text-2xl font-bold text-blue-600">{avgAvailability.toFixed(1)}%</p>
            </div>
            <Activity className="w-8 h-8 text-blue-500" />
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-sm border">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Total Customers</p>
              <p className="text-2xl font-bold text-purple-600">{totalCustomers.toLocaleString()}</p>
            </div>
            <Power className="w-8 h-8 text-purple-500" />
          </div>
        </div>
      </div>

      {/* Feeders Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {feeders.map((feeder) => (
          <div key={feeder.id} className="bg-white rounded-lg shadow-sm border overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b bg-gray-50">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{feeder.name}</h3>
                  <p className="text-sm text-gray-500">{feeder.id}</p>
                </div>
                <div className={`px-3 py-1 rounded-full text-sm font-medium flex items-center space-x-1 ${getStatusColor(feeder.status)}`}>
                  {getStatusIcon(feeder.status)}
                  <span className="capitalize">{feeder.status}</span>
                </div>
              </div>
              <div className="flex justify-start">
                <span className={`px-2 py-1 rounded-md text-xs font-medium border ${getBandColor(feeder.band)}`}>
                  {feeder.band}
                </span>
              </div>
            </div>

            {/* Metrics */}
            <div className="p-6 space-y-4">
              {/* Availability */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-700">Availability</span>
                  <span className="text-sm font-bold text-gray-900">{feeder.availability}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                    style={{ width: `${feeder.availability}%` }}
                  ></div>
                </div>
              </div>

              {/* Load */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-700">Load</span>
                  <span className="text-sm font-bold text-gray-900">{feeder.load}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className={`h-2 rounded-full transition-all duration-300 ${getLoadColor(feeder.load)}`}
                    style={{ width: `${feeder.load}%` }}
                  ></div>
                </div>
              </div>

              {/* Electrical Parameters */}
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="text-center">
                  <p className="text-xs text-gray-500">Voltage (kV)</p>
                  <p className="text-lg font-bold text-gray-900">
                    {feeder.status === 'online' || feeder.status === 'alarm' ? feeder.voltage.toFixed(1) : '0.0'}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-gray-500">Current (A)</p>
                  <p className="text-lg font-bold text-gray-900">
                    {feeder.status === 'online' || feeder.status === 'alarm' ? Math.round(feeder.current) : '0'}
                  </p>
                </div>
              </div>

              {/* Additional Info */}
              <div className="text-xs text-gray-500">
                <p>Last Outage: {feeder.lastOutage}</p>
                <p>Total Outages: {feeder.totalOutages}</p>
                <p>Customers: {feeder.customers.toLocaleString()}</p>
                <p>Location: {feeder.location}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ElectricityDashboard;
