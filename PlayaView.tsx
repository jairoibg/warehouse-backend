import React, { useState, useMemo } from 'react';

interface Package {
  packageId: string;
  productCode: string;
  surtido: string;
  qty: number;
  reservedQty: number;
  abcClass: string;
  velocity: number;
  cost: number;
  season: string;
  daysOld: number;
}

interface PlayaLocation {
  id: string;
  brand: string;
  market: string;
  type: string;
  totalStock: number;
  packages: Package[];
}

interface PlayaViewProps {
  locations: PlayaLocation[];
  onSearchInB2C?: (productCode: string) => void;
}

// Agrupar paquetes por surtido
interface SurtidoGroup {
  surtido: string;
  productCode: string;
  abcClass: string;
  totalQty: number;
  totalPackages: number;
  packages: Package[];
  season: string;
  velocity: number;
}

const ABC_COLORS: Record<string, string> = {
  'A': 'bg-green-500',
  'B': 'bg-yellow-500',
  'C': 'bg-orange-500',
  'D': 'bg-red-500',
};

const ABC_TEXT_COLORS: Record<string, string> = {
  'A': 'text-green-600',
  'B': 'text-yellow-600',
  'C': 'text-orange-600',
  'D': 'text-red-600',
};

const BRAND_COLORS: Record<string, string> = {
  'BLACK': 'bg-gray-800 text-white',
  'GOLD': 'bg-amber-500 text-white',
  'WHITE': 'bg-slate-200 text-gray-800',
};

export default function PlayaView({ locations, onSearchInB2C }: PlayaViewProps) {
  const [selectedBrand, setSelectedBrand] = useState<string>('ALL');
  const [selectedMarket, setSelectedMarket] = useState<string>('ALL');
  const [expandedSurtidos, setExpandedSurtidos] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');

  // Filtrar ubicaciones de Playa
  const playaLocations = useMemo(() => {
    return locations.filter(loc => 
      loc.type === 'PLAYA' && 
      !loc.id.includes('SalvaStock')
    );
  }, [locations]);

  // Aplicar filtros de marca y mercado
  const filteredLocations = useMemo(() => {
    return playaLocations.filter(loc => {
      if (selectedBrand !== 'ALL' && loc.brand !== selectedBrand) return false;
      if (selectedMarket !== 'ALL' && loc.market !== selectedMarket) return false;
      return true;
    });
  }, [playaLocations, selectedBrand, selectedMarket]);

  // Agrupar todos los paquetes por surtido
  const surtidoGroups = useMemo(() => {
    const groups: Record<string, SurtidoGroup> = {};
    
    filteredLocations.forEach(loc => {
      (loc.packages || []).forEach(pkg => {
        const key = pkg.surtido || pkg.productCode;
        
        // Filtro de búsqueda
        if (searchTerm) {
          const searchLower = searchTerm.toLowerCase();
          if (!key.toLowerCase().includes(searchLower) && 
              !pkg.productCode.toLowerCase().includes(searchLower)) {
            return;
          }
        }
        
        if (!groups[key]) {
          groups[key] = {
            surtido: pkg.surtido,
            productCode: pkg.productCode,
            abcClass: pkg.abcClass,
            totalQty: 0,
            totalPackages: 0,
            packages: [],
            season: pkg.season,
            velocity: pkg.velocity,
          };
        }
        
        groups[key].totalQty += pkg.qty;
        groups[key].totalPackages += 1;
        groups[key].packages.push(pkg);
        
        // Actualizar ABC al mejor encontrado
        if (pkg.abcClass < groups[key].abcClass) {
          groups[key].abcClass = pkg.abcClass;
        }
      });
    });

    // Convertir a array y ordenar por ABC y cantidad
    return Object.values(groups).sort((a, b) => {
      if (a.abcClass !== b.abcClass) return a.abcClass.localeCompare(b.abcClass);
      return b.totalQty - a.totalQty;
    });
  }, [filteredLocations, searchTerm]);

  // Estadísticas
  const stats = useMemo(() => {
    const total = surtidoGroups.reduce((acc, g) => acc + g.totalQty, 0);
    const byABC = { A: 0, B: 0, C: 0, D: 0 };
    surtidoGroups.forEach(g => {
      byABC[g.abcClass as keyof typeof byABC] += g.totalQty;
    });
    return { total, byABC, surtidos: surtidoGroups.length };
  }, [surtidoGroups]);

  const toggleExpanded = (surtido: string) => {
    const newExpanded = new Set(expandedSurtidos);
    if (newExpanded.has(surtido)) {
      newExpanded.delete(surtido);
    } else {
      newExpanded.add(surtido);
    }
    setExpandedSurtidos(newExpanded);
  };

  const handleSearchInB2C = (productCode: string) => {
    if (onSearchInB2C) {
      onSearchInB2C(productCode);
    }
  };

  return (
    <div className="p-4 bg-gray-50 min-h-screen">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          🏖️ Zona de Playa - Stock en Descarga
        </h1>
        <p className="text-gray-600 mt-1">
          Stock pendiente de ubicar desde contenedores
        </p>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex flex-wrap gap-4 items-center">
          {/* Filtro Marca */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Marca</label>
            <div className="flex gap-2">
              <button
                onClick={() => setSelectedBrand('ALL')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  selectedBrand === 'ALL' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Todas
              </button>
              {['BLACK', 'GOLD', 'WHITE'].map(brand => (
                <button
                  key={brand}
                  onClick={() => setSelectedBrand(brand)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    selectedBrand === brand 
                      ? BRAND_COLORS[brand]
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {brand}
                </button>
              ))}
            </div>
          </div>

          {/* Filtro Mercado */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Mercado</label>
            <div className="flex gap-2">
              <button
                onClick={() => setSelectedMarket('ALL')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  selectedMarket === 'ALL' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Todos
              </button>
              {['B2C', 'B2B'].map(market => (
                <button
                  key={market}
                  onClick={() => setSelectedMarket(market)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    selectedMarket === market 
                      ? 'bg-indigo-600 text-white' 
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {market}
                </button>
              ))}
            </div>
          </div>

          {/* Búsqueda */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 mb-1">Buscar</label>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar surtido o referencia..."
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Estadísticas */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-2xl font-bold text-gray-800">{stats.total.toLocaleString()}</div>
          <div className="text-sm text-gray-600">Total Unidades</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-2xl font-bold text-gray-800">{stats.surtidos}</div>
          <div className="text-sm text-gray-600">Surtidos</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-green-500">
          <div className="text-2xl font-bold text-green-600">{stats.byABC.A.toLocaleString()}</div>
          <div className="text-sm text-gray-600">Clase A</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-yellow-500">
          <div className="text-2xl font-bold text-yellow-600">{stats.byABC.B.toLocaleString()}</div>
          <div className="text-sm text-gray-600">Clase B</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-red-500">
          <div className="text-2xl font-bold text-red-600">{(stats.byABC.C + stats.byABC.D).toLocaleString()}</div>
          <div className="text-sm text-gray-600">Clase C/D</div>
        </div>
      </div>

      {/* Lista de Surtidos */}
      <div className="space-y-3">
        {surtidoGroups.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <div className="text-gray-400 text-5xl mb-4">📦</div>
            <div className="text-gray-600">No hay stock en Playa con los filtros seleccionados</div>
          </div>
        ) : (
          surtidoGroups.map((group) => {
            const isExpanded = expandedSurtidos.has(group.surtido);
            
            return (
              <div key={group.surtido} className="bg-white rounded-lg shadow overflow-hidden">
                {/* Cabecera del surtido */}
                <div 
                  className="p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => toggleExpanded(group.surtido)}
                >
                  <div className="flex items-center gap-4">
                    {/* Indicador ABC */}
                    <div className={`w-10 h-10 rounded-full ${ABC_COLORS[group.abcClass]} flex items-center justify-center text-white font-bold text-lg`}>
                      {group.abcClass}
                    </div>
                    
                    {/* Info del surtido */}
                    <div>
                      <div className="font-semibold text-gray-800">{group.surtido}</div>
                      <div className="text-sm text-gray-500">
                        {group.productCode} • {group.season}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    {/* Estadísticas */}
                    <div className="text-right">
                      <div className="font-bold text-lg text-gray-800">{group.totalQty.toLocaleString()} uds</div>
                      <div className="text-sm text-gray-500">{group.totalPackages} paquetes</div>
                    </div>

                    {/* Botón buscar en B2C */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSearchInB2C(group.productCode);
                      }}
                      className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
                      title="Buscar ubicación en B2C"
                    >
                      🔍 Buscar en B2C
                    </button>

                    {/* Icono expandir */}
                    <div className={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                      <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                </div>

                {/* Detalle de paquetes (expandido) */}
                {isExpanded && (
                  <div className="border-t border-gray-200 bg-gray-50 p-4">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500">
                          <th className="pb-2 font-medium">Paquete</th>
                          <th className="pb-2 font-medium text-right">Cantidad</th>
                          <th className="pb-2 font-medium text-right">Reservado</th>
                          <th className="pb-2 font-medium text-center">ABC</th>
                          <th className="pb-2 font-medium text-right">Días</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.packages.map((pkg, idx) => (
                          <tr key={`${pkg.packageId}-${idx}`} className="border-t border-gray-200">
                            <td className="py-2 font-mono text-gray-700">{pkg.packageId}</td>
                            <td className="py-2 text-right font-medium">{pkg.qty}</td>
                            <td className="py-2 text-right text-gray-500">{pkg.reservedQty || 0}</td>
                            <td className="py-2 text-center">
                              <span className={`px-2 py-0.5 rounded text-xs font-bold ${ABC_COLORS[pkg.abcClass]} text-white`}>
                                {pkg.abcClass}
                              </span>
                            </td>
                            <td className="py-2 text-right text-gray-500">{pkg.daysOld}d</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}